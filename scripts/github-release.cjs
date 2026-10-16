const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { compareVersions } = require('./release-tools.cjs');

function createGitHub(root, repository, commit, version) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GitHub 仓库配置无效');
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0', GCM_TRACE: '0', GCM_TRACE_SECRETS: '0' };
  const credentials = spawnSync('git', ['credential', 'fill'], { cwd: root, input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`, encoding: 'utf8', windowsHide: true, env: environment, timeout: 60000 });
  if (credentials.status !== 0) throw new Error('无法读取已有 GitHub 登录，请先登录 Git Credential Manager。');
  const secret = credentials.stdout.split(/\r?\n/).find((line) => line.startsWith('password='))?.slice(9);
  if (!secret) throw new Error('没有可用的 GitHub 授权。');
  const headers = { Authorization: `Bearer ${secret}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Xianqiji-one-click-release' };
  const api = `https://api.github.com/repos/${repository}`;
  const tag = `v${version}`;
  async function request(url, options = {}, allowMissing = false) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !['api.github.com', 'uploads.github.com'].includes(target.hostname)) throw new Error('拒绝向非 GitHub API 地址发送授权。');
    const response = await fetch(target, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(options.body ? 30 * 60000 : 60000) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}：${target.pathname}；未输出授权信息。`);
    return response.json();
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function preflight() {
    const repositoryInfo = await request(api);
    if (!repositoryInfo.permissions?.push) throw new Error('当前 GitHub 登录没有仓库发布权限。');
    const latest = await request(`${api}/releases/latest`, {}, true);
    if (latest && /^v\d+\.\d+\.\d+$/.test(latest.tag_name) && compareVersions(latest.tag_name.slice(1), version) > 0) throw new Error('GitHub 已有更新正式版本，禁止回退 latest。');
    const reference = await request(`${api}/git/ref/tags/${tag}`, {}, true);
    if (reference) {
      let object = reference.object;
      for (let depth = 0; object.type === 'tag' && depth < 8; depth += 1) object = (await request(`${api}/git/tags/${object.sha}`)).object;
      if (object.type !== 'commit' || object.sha !== commit) throw new Error('已有同版本 Git 标签属于其他提交，禁止覆盖。');
    }
    const release = await request(`${api}/releases/tags/${tag}`, {}, true);
    if (release && release.target_commitish !== commit) throw new Error('已有同版本 Release 不属于当前完整提交，拒绝覆盖。');
    return release;
  }
  function verifyAsset(asset, file) {
    if (asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== `sha256:${file.sha256}`) throw new Error(`GitHub 同名资源缺失或校验不符：${file.name}。不自动删除或覆盖，请人工检查草稿。`);
  }
  async function stage(prepared) {
    let release = await preflight();
    if (!release) {
      release = await request(`${api}/releases`, json('POST', { tag_name: tag, target_commitish: commit, name: `弦栖霁 ${tag}`, body: `${fs.readFileSync(`${prepared.directory}/update-notes.txt`, 'utf8')}\n\n包含 Windows 安装包、便携包、安卓 APK、在线曲库部署包、签名清单和 SHA-256 校验文件。安卓请勿先卸载；升级前备份音乐库。`, draft: true, prerelease: false }));
    }
    for (const file of prepared.files) {
      let asset = release.assets.find((value) => value.name === file.name);
      if (!asset) {
        if (!release.draft) throw new Error(`公开版本缺少 ${file.name}，禁止修改已经发布的版本。`);
        const url = new URL(release.upload_url.replace(/\{.*$/, ''));
        if (url.hostname !== 'uploads.github.com' || url.pathname.toLowerCase() !== `/repos/${repository}/releases/${release.id}/assets`.toLowerCase()) throw new Error('GitHub 上传地址不符。');
        url.searchParams.set('name', file.name);
        asset = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }, body: Readable.toWeb(fs.createReadStream(file.filename)), duplex: 'half' });
        if (!asset.digest) asset = await request(`${api}/releases/assets/${asset.id}`);
      }
      verifyAsset(asset, file);
      console.log(`GitHub 已核对：${file.name}`);
    }
    return release;
  }
  async function finalize(prepared) {
    const release = await stage(prepared);
    if (release.draft) await request(`${api}/releases/${release.id}`, json('PATCH', { draft: false, prerelease: false, make_latest: 'true' }));
    const published = await request(`${api}/releases/tags/${tag}`);
    if (published.draft || published.prerelease) throw new Error('GitHub 未公开为正式版。');
    for (const file of prepared.files) verifyAsset(published.assets.find((asset) => asset.name === file.name) || {}, file);
    return published.html_url;
  }
  async function androidCode(previousVersion) {
    if (!/^\d+\.\d+\.\d+$/.test(previousVersion)) throw new Error('线上版本无效。');
    const file = await request(`${api}/contents/android/app/build.gradle?ref=v${previousVersion}`);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('无法核对已发布版本的安卓版本号。');
    const code = Number(Buffer.from(file.content, 'base64').toString('utf8').match(/versionCode\s+(\d+)/)?.[1]);
    if (!Number.isSafeInteger(code) || code < 1) throw new Error('线上源码的 Android versionCode 无效。');
    return code;
  }
  return { preflight, stage, finalize, androidCode };
}

module.exports = { createGitHub };
