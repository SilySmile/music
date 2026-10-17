const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const trust = require('../updates/public.json');
const { baseUrl, compareVersions, verifyEnvelope, artifactUrl } = require('../updates/protocol.cjs');

module.exports = function createUpdates({ app, fetch, progress = () => {}, testing = false, launch = spawn, portable = !!process.env.PORTABLE_EXECUTABLE_DIR, trustConfig = trust, executable = process.execPath, installerTempRoot = app.getPath('temp') }) {
  const directory = path.join(app.getPath('userData'), 'Updates');
  const configPath = path.join(app.getPath('userData'), 'update-settings.json');
  const releasePath = path.join(directory, 'checked-release.json');
  const platform = portable ? 'win-x64-portable' : 'win-x64';
  let settings;
  let checked;
  let state = { phase: 'idle', currentVersion: app.getVersion(), platform, bytes: 0, total: 0, message: '' };
  let running = false;
  let installing = false;
  let controller;
  async function atomic(filename, value) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2)); await fs.rename(temporary, filename);
  }
  async function config() {
    if (!settings) {
      settings = { baseUrl: trustConfig.defaultBaseUrl, autoCheck: false, lastChecked: 0, highestVersion: app.getVersion() };
      try { const saved = JSON.parse(await fs.readFile(configPath, 'utf8')); settings = { ...settings, baseUrl: baseUrl(saved.baseUrl), autoCheck: saved.autoCheck === true, lastChecked: Number(saved.lastChecked) || 0, highestVersion: compareVersions(saved.highestVersion, app.getVersion()) > 0 ? saved.highestVersion : app.getVersion() }; } catch {}
    }
    return { ...settings, currentVersion: app.getVersion(), platform, configPath, downloadDirectory: directory };
  }
  function emit(patch) { state = { ...state, ...patch }; progress({ ...state }); return { ...state }; }
  async function saveConfig(value) {
    if (running) throw new Error('请先暂停下载或等待检查结束，再修改地址');
    await config(); const next = { ...settings, baseUrl: baseUrl(value?.baseUrl), autoCheck: value?.autoCheck === true };
    await atomic(configPath, next); settings = next; checked = undefined;
    await fs.rm(releasePath, { force: true }); emit({ phase: 'idle', release: undefined, bytes: 0, total: 0, message: '地址已保存；请检查更新' });
    return config();
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('更新服务器发生重定向，请填写最终 HTTPS 地址'); }
    return response;
  }
  async function release() {
    await config();
    const saved = checked || JSON.parse(await fs.readFile(releasePath, 'utf8'));
    if (saved.baseUrl !== settings.baseUrl) throw new Error('更新地址已变更，请重新检查更新');
    const payload = verifyEnvelope(saved.envelope, trustConfig.publicKey);
    if (compareVersions(payload.version, settings.highestVersion) < 0 || compareVersions(payload.version, app.getVersion()) <= 0) throw new Error('拒绝降级或安装过期版本，请重新检查更新');
    const artifact = payload.artifacts[platform]; if (!artifact) throw new Error('此版本尚未提供适用于当前平台的安装包');
    return { payload, artifact };
  }
  async function hash(filename) { const digest = crypto.createHash('sha256'); for await (const bytes of createReadStream(filename)) digest.update(bytes); return digest.digest('hex'); }
  const filename = (artifact, partial = false) => path.join(directory, `${artifact.sha256}${platform === 'android' ? '.apk' : '.exe'}${partial ? '.part' : ''}`);
  async function check() {
    if (running) throw new Error('另一个更新操作正在进行');
    running = true; emit({ phase: 'checking', message: '正在验证更新清单…' });
    try {
      await config();
      settings.lastChecked = Date.now(); await atomic(configPath, settings);
      const response = await request(new URL('manifest.json', settings.baseUrl).href, { signal: AbortSignal.timeout(20000) });
      if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > 256 * 1024) { await response.body?.cancel(); throw new Error(`更新服务不可用（HTTP ${response.status}）`); }
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new Error('更新清单过大'); chunks.push(Buffer.from(value)); } } finally { await reader.cancel().catch(() => {}); }
      const envelope = Buffer.concat(chunks).toString('utf8'); const payload = verifyEnvelope(envelope, trustConfig.publicKey);
      if (compareVersions(payload.version, settings.highestVersion) < 0 && compareVersions(payload.version, app.getVersion()) > 0) throw new Error('服务器清单版本倒退，已拒绝，请联系发布者');
      settings.highestVersion = compareVersions(payload.version, settings.highestVersion) > 0 ? payload.version : settings.highestVersion;
      settings.lastChecked = Date.now(); await atomic(configPath, settings);
      const artifact = payload.artifacts[platform];
      if (compareVersions(payload.version, app.getVersion()) <= 0) return emit({ phase: 'up-to-date', release: undefined, bytes: 0, total: 0, message: '当前已是最新版本' });
      if (!artifact) throw new Error('新版本尚无当前平台安装包');
      checked = { baseUrl: settings.baseUrl, envelope }; await atomic(releasePath, checked);
      const bytes = Math.min(artifact.size, (await fs.stat(filename(artifact, true)).catch(() => ({ size: 0 }))).size);
      const complete = await fs.stat(filename(artifact)).catch(() => null);
      const valid = complete?.size === artifact.size && await hash(filename(artifact)) === artifact.sha256;
      return emit({ phase: valid ? 'downloaded' : 'available', release: { version: payload.version, notes: payload.notes, issuedAt: payload.issuedAt, size: artifact.size, kind: artifact.kind }, bytes: valid ? artifact.size : bytes, total: artifact.size, message: valid ? '安装包已校验，可安装' : '发现新版本，点击下载；中断后可继续' });
    } catch (error) { return emit({ phase: 'error', message: error.message || '检查更新失败' }); }
    finally { running = false; }
  }
  async function download() {
    if (running) throw new Error('另一个更新操作正在进行');
    running = true; controller = new AbortController();
    let handle;
    try {
      const { payload, artifact } = await release(); await fs.mkdir(directory, { recursive: true });
      const partial = filename(artifact, true); const target = filename(artifact);
      let offset = (await fs.stat(partial).catch(() => ({ size: 0 }))).size;
      if (offset > artifact.size) { await fs.truncate(partial, 0); offset = 0; }
      emit({ phase: 'downloading', bytes: offset, total: artifact.size, message: '正在下载并保存进度…' });
      if (offset < artifact.size) {
        const response = await request(artifactUrl(settings.baseUrl, artifact), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60 * 60000)]), headers: offset ? { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' } });
        if (response.status !== 200 && response.status !== 206) { await response.body?.cancel(); throw new Error(`下载失败（HTTP ${response.status}）`); }
        if (response.status === 200 && offset) { await fs.truncate(partial, 0); offset = 0; }
        if (response.status === 206 && response.headers.get('content-range') !== `bytes ${offset}-${artifact.size - 1}/${artifact.size}`) { await response.body?.cancel(); throw new Error('服务器续传范围不一致，未追加安装包'); }
        handle = await fs.open(partial, offset ? 'r+' : 'w');
        const reader = response.body.getReader(); let emitted = 0;
        try {
          while (true) {
            controller.signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
            if (offset + value.length > artifact.size) throw new Error('安装包超过清单声明大小');
            let written = 0;
            while (written < value.length) { const result = await handle.write(value, written, value.length - written, offset + written); if (!result.bytesWritten) throw new Error('磁盘写入失败'); written += result.bytesWritten; }
            offset += written;
            if (Date.now() - emitted > 250) { emitted = Date.now(); emit({ bytes: offset }); }
          }
          await handle.sync();
        } finally { await reader.cancel().catch(() => {}); }
        await handle.close(); handle = undefined;
      }
      if (offset !== artifact.size) throw new Error('下载尚未完整，已保留进度，可继续下载');
      if (await hash(partial) !== artifact.sha256) { await fs.rm(partial, { force: true }); throw new Error('安装包完整性校验失败，已移除不可信文件，请重新下载'); }
      await fs.rename(partial, target);
      return emit({ phase: 'downloaded', bytes: artifact.size, total: artifact.size, release: { version: payload.version, notes: payload.notes, issuedAt: payload.issuedAt, size: artifact.size, kind: artifact.kind }, message: '下载完成且 SHA-256 校验通过，尚未安装' });
    } catch (error) { return emit({ phase: controller.signal.aborted ? 'paused' : 'error', message: controller.signal.aborted ? '下载已暂停，文件保留，可继续' : error.message || '下载失败，已保存部分文件' }); }
    finally { await handle?.sync().catch(() => {}); await handle?.close().catch(() => {}); controller = undefined; running = false; }
  }
  async function install() {
    if (running || installing) throw new Error('另一个更新或安装操作正在进行');
    installing = true;
    let launched = false;
    let stage;
    let staged;
    try {
      const { payload, artifact } = await release(); const target = filename(artifact);
      if ((await fs.stat(target)).size !== artifact.size || await hash(target) !== artifact.sha256) throw new Error('安装包已改变，拒绝运行，请重新下载');
      if (testing) return { installed: false, testVerified: true, path: target };
      if (portable) return { installed: false, portable: true, path: target };
      const installRoot = path.dirname(executable);
      const temporaryRoot = await fs.realpath(installerTempRoot);
      const relative = path.relative(await fs.realpath(installRoot), temporaryRoot);
      if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('系统临时目录位于程序安装目录内，无法安全启动更新。请将 TEMP 恢复为独立的临时目录后重试。');
      // NSIS closes processes whose executable is beneath $INSTDIR. Never run
      // the installer from Data/Updates: that makes it close itself mid-update.
      stage = await fs.mkdtemp(path.join(temporaryRoot, 'xianqiji-update-'));
      staged = path.join(stage, `Xianqiji-Setup-${payload.version}-x64.exe`);
      await fs.copyFile(target, staged, require('node:fs').constants.COPYFILE_EXCL);
      if ((await fs.stat(staged)).size !== artifact.size || await hash(staged) !== artifact.sha256) throw new Error('安装临时副本校验失败，未退出播放器，请重试。');
      // NSIS requires /D= to be last and unquoted, even with spaces. Quote only
      // argv0; no shell interprets the destination or other arguments.
      await new Promise((resolve, reject) => { const child = launch(staged, ['/currentuser', '/XQ_STAGED', `/D=${installRoot}`], { cwd: stage, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, argv0: `"${staged}"`, env: { ...process.env, TEMP: stage, TMP: stage } }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
      launched = true;
      setTimeout(() => app.quit(), 300);
      return { installed: true };
    } finally {
      if (!launched) {
        if (staged) await fs.unlink(staged).catch(() => {});
        if (stage) await fs.rmdir(stage).catch(() => {});
        installing = false;
      }
    }
  }
  return { config, saveConfig, check, download, pause: () => { controller?.abort(); return { ...state }; }, state: () => ({ ...state }), install };
};
