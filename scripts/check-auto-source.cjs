const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'); const directory = path.join(root, 'test-results', `auto-source-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const token = 'auto-source-test-token-not-production';
  const auth = path.join(directory, 'auth.json'); await fs.writeFile(auth, JSON.stringify({ writers: [createHash('sha256').update(token).digest('hex')], readers: [] }));
  const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  const backend = spawn(process.env.PYTHON_EXE || 'python', [path.join(root, 'deployment/library-server.py')], { cwd: root, env: { ...process.env, XQ_LIBRARY_DATA: path.join(directory, 'server'), XQ_LIBRARY_AUTH: auth, XQ_LIBRARY_PORT: String(port), PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, stdio: 'ignore' });
  const request = async (route, body) => { const response = await fetch(endpoint + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); assert.equal(response.status, 200); return response.json(); };
  let application; const errors = [];
  const environment = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: path.join(directory, 'device') }; delete environment.ELECTRON_RUN_AS_NODE;
  async function launch() {
    application = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], cwd: root, env: environment, timeout: 60000 });
    await application.evaluate(({ net }, endpoint) => {
      const original = net.fetch.bind(net);
      globalThis.autoSourcePauseGate = false;
      net.fetch = async (url, options) => {
        const target = new URL(url);
        if (target.origin === 'https://auto.fixture.test' && target.pathname.startsWith('/api/')) {
          if (globalThis.autoSourcePauseGate && target.pathname.endsWith('/info')) await new Promise((resolve) => setTimeout(resolve, 1000));
          return original(endpoint + target.pathname.slice(4) + target.search, options);
        }
        if (target.pathname.endsWith('/chat/completions')) throw new Error('Test blocks paid AI');
        return original(url, options);
      };
    }, endpoint);
    const page = await application.firstWindow(); page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(20000); return page;
  }
  async function settings(page) {
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    const source = page.locator('.online-source-settings');
    await page.waitForFunction(() => document.querySelector('[aria-label="在线音源链接"]')?.value);
    return source;
  }
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) { if (await fetch(endpoint + '/info', { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok, () => false)) break; if (backend.exitCode !== null) throw Error('Fixture server exited'); await new Promise((resolve) => setTimeout(resolve, 100)); }
    let page = await launch();
    await page.getByRole('button', { name: '先听听示例', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    let source = await settings(page);
    const connection = path.join(directory, 'owner.xqsource'); await fs.writeFile(connection, JSON.stringify({ format: 'xianqiji-source-connection', version: 1, baseUrl: 'https://auto.fixture.test/api/', token }));
    await source.getByLabel('导入曲库连接配置', { exact: true }).setInputFiles(connection);
    await source.getByRole('status').filter({ hasText: '已填入地址和密钥' }).waitFor();
    assert.equal((await request('/info')).trackCount, 0);
    await source.getByRole('button', { name: '一键连接并自动上传', exact: true }).click();
    await source.locator('.source-auto-status').filter({ hasText: '上传 3' }).waitFor({ timeout: 60000 });
    const first = (await request('/tracks')).tracks;
    assert.equal(first.length, 3); for (const record of first) assert.equal(record.revision, 1);
    await source.getByRole('button', { name: '立即核对', exact: true }).click();
    await source.locator('.source-auto-status').filter({ hasText: '上传 0' }).waitFor();
    for (const record of (await request('/tracks')).tracks) assert.equal(record.revision, 1);
    const track = first[0];
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '导入音乐', exact: true }).first().click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '单独导入歌词', exact: true }).click();
    const chinese = track.metadata.lyrics.map((line, index) => `[${Math.floor(line.time / 60).toString().padStart(2, '0')}:${(line.time % 60).toFixed(2).padStart(5, '0')}]自动上传中文测试${index}`).join('\n');
    await (await chooser).setFiles({ name: `${track.metadata.title}.zh.lrc`, mimeType: 'text/plain', buffer: Buffer.from(chinese) });
    await page.getByRole('button', { name: '保存歌词到所选歌曲', exact: true }).click();
    await page.getByRole('dialog', { name: '单独导入歌词' }).waitFor({ state: 'hidden' });
    for (let attempt = 0; attempt < 120; attempt += 1) { if ((await request(`/tracks/${track.metadata.id}`)).revision === 2) break; await new Promise((resolve) => setTimeout(resolve, 250)); }
    assert.equal((await request(`/tracks/${track.metadata.id}`)).metadata.lyrics[0].translation, '自动上传中文测试0');
    await page.evaluate(async ({ id, lyrics }) => {
      await window.tingyuDesktop.patchLibraryTrack(id, { lyrics });
    }, { id: track.metadata.id, lyrics: track.metadata.lyrics.map((line, index) => index === 0 ? { ...line, translation: '自动上传保存的中文测试' } : line) });
    await application.close(); application = null;
    page = await launch(); await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if ((await request(`/tracks/${track.metadata.id}`)).revision === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal((await request(`/tracks/${track.metadata.id}`)).metadata.lyrics[0].translation, '自动上传保存的中文测试');
    assert.equal((await request(`/tracks/${track.metadata.id}`)).revision, 3);
    source = await settings(page);
    await source.getByRole('button', { name: '暂停自动上传', exact: true }).click();
    await source.locator('.source-auto-status').filter({ hasText: '自动上传已暂停' }).waitFor();
    assert.equal((await page.evaluate(() => window.tingyuDesktop.getSourceConfig())).autoSync, false);
    const saved = await fs.readFile(path.join(directory, 'device/online-source.json'), 'utf8'); assert.ok(!saved.includes(token));
    const remote = await request(`/tracks/${track.metadata.id}`);
    const pending = await request('/uploads', { metadata: { ...remote.metadata, lyrics: remote.metadata.lyrics.map((line, index) => index === 0 ? { ...line, translation: '其他设备的不同译文' } : line) }, audio: remote.audio, cover: remote.cover, expectedRevision: remote.revision });
    await request(`/uploads/${pending.id}/finish`, {});
    await source.getByRole('button', { name: '一键连接并自动上传', exact: true }).click();
    await source.locator('.source-auto-status').filter({ hasText: '待核对 1' }).waitFor();
    assert.equal((await request(`/tracks/${track.metadata.id}`)).revision, 4);
    await source.getByRole('button', { name: '暂停自动上传', exact: true }).click();
    await source.locator('.source-auto-status').filter({ hasText: '自动上传已暂停' }).waitFor();
    await source.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'test-results/auto-source-desktop.png') });
    await page.setViewportSize({ width: 412, height: 915 }); await source.locator('h3').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'test-results/auto-source-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('PASS real HTTP/Electron: imported connection does not upload until enabled; automatic upload of all 3 demo songs; repeat skips; restart uploads saved translation with settings closed; pause persists; concurrent translation retained; encrypted key; no paid AI/renderer errors');
  } finally { if (application) await application.close(); backend.kill(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
