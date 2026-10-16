const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'); const directory = path.join(root, 'test-results', `online-source-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const token = 'test-source-owner-token-not-production'; const hash = (value) => createHash('sha256').update(value).digest('hex');
  const auth = path.join(directory, 'auth.json'); await fs.writeFile(auth, JSON.stringify({ writers: [hash(token)], readers: [] }));
  const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  const backend = spawn(process.env.PYTHON_EXE || 'python', [path.join(root, 'deployment/library-server.py')], { cwd: root, env: { ...process.env, XQ_LIBRARY_DATA: path.join(directory, 'server'), XQ_LIBRARY_AUTH: auth, XQ_LIBRARY_PORT: String(port), PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, stdio: 'ignore' });
  const request = async (route, body) => { const response = await fetch(endpoint + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); assert.equal(response.status, 200); return response.json(); };
  let application; const errors = [];
  const environment = { ...process.env, TINGYU_TEST: '1' }; delete environment.ELECTRON_RUN_AS_NODE;
  async function launch(name) {
    application = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], cwd: root, env: { ...environment, TINGYU_TEST_DATA: path.join(directory, name) }, timeout: 60000 });
    await application.evaluate(({ net }, endpoint) => {
      const original = net.fetch.bind(net);
      net.fetch = (url, options) => {
        const target = new URL(url);
        if (target.origin === 'https://library.fixture.test' && target.pathname.startsWith('/api/')) return original(endpoint + target.pathname.slice(4) + target.search, options);
        if (target.pathname.endsWith('/chat/completions')) throw new Error('Test blocks paid AI');
        return original(url, options);
      };
    }, endpoint);
    const page = await application.firstWindow(); page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(12000); return page;
  }
  async function configure(page) {
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    const source = page.locator('.online-source-settings');
    await source.locator('.cloud-advanced > summary').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="在线音源链接"]')?.value);
    await source.getByLabel('在线音源链接', { exact: true }).fill('https://library.fixture.test/api/');
    await source.getByLabel('在线曲库访问密钥', { exact: true }).fill(token);
    await source.getByText('使用系统加密记住曲库密钥', { exact: true }).check();
    await source.getByRole('button', { name: '保存并连接 / 刷新', exact: true }).click();
    await source.getByRole('status').filter({ hasText: '连接成功' }).waitFor(); return source;
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) { if (await fetch(endpoint + '/info', { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok, () => false)) break; if (backend.exitCode !== null) throw Error('Fixture server exited'); await new Promise((resolve) => setTimeout(resolve, 100)); }
    let page = await launch('device-a');
    await page.getByRole('button', { name: '先听听示例', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    let source = await configure(page);
    await source.getByRole('button', { name: '本地可上传 · 3', exact: true }).click(); await source.getByRole('button', { name: '选择当前列表', exact: true }).click();
    await source.getByRole('button', { name: '上传到线上 · 3', exact: true }).click();
    assert.equal((await request('/info')).trackCount, 0);
    await source.getByRole('button', { name: '取消', exact: true }).click(); assert.equal((await request('/info')).trackCount, 0);
    await source.getByRole('button', { name: '上传到线上 · 3', exact: true }).click(); await source.getByRole('button', { name: '确认上传', exact: true }).click();
    await source.getByRole('status').filter({ hasText: '上传完成：3 首' }).waitFor({ timeout: 60000 }); assert.equal((await request('/info')).trackCount, 3);
    assert.ok(!(await fs.readFile(path.join(directory, 'device-a/online-source.json'), 'utf8')).includes(token));
    const uploaded = (await request('/tracks')).tracks;
    await application.close(); application = null;
    page = await launch('device-b'); await page.waitForSelector('.empty-state'); source = await configure(page);
    await source.getByRole('button', { name: '选择当前列表', exact: true }).click(); await source.getByRole('button', { name: '下载 / 补充到本地 · 3', exact: true }).click();
    assert.equal((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).length, 0);
    await source.getByRole('button', { name: '确认下载并保存', exact: true }).click();
    await source.getByRole('status').filter({ hasText: '下载 / 补充完成：3 首' }).waitFor({ timeout: 60000 }); assert.equal(await page.locator('.track-row').count(), 3);
    const records = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    for (const record of records) { const original = uploaded.find((track) => track.metadata.id === record.metadata.id); assert.equal(record.audio.sha256, original.audio.sha256); assert.deepEqual(record.metadata.lyrics, original.metadata.lyrics); }
    const rival = uploaded[0];
    const pending = await request('/uploads', { metadata: { ...rival.metadata, album: 'Changed by another device' }, audio: rival.audio, cover: rival.cover, expectedRevision: rival.revision });
    await request(`/uploads/${pending.id}/finish`, {});
    await source.getByRole('button', { name: '本地可上传 · 3', exact: true }).click();
    await source.locator('.source-song').filter({ hasText: rival.metadata.title }).getByRole('checkbox').check();
    await source.getByRole('button', { name: '上传到线上 · 1', exact: true }).click(); await source.getByRole('button', { name: '确认上传', exact: true }).click();
    await source.getByRole('status').filter({ hasText: '上传完成：1 首' }).waitFor(); assert.equal((await request(`/tracks/${rival.metadata.id}`)).revision, 2);
    assert.equal((await request(`/tracks/${rival.metadata.id}`)).metadata.album, 'Changed by another device');
    await source.getByRole('button', { name: '保存并连接 / 刷新', exact: true }).click(); await source.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    await page.locator('.startup-screen').waitFor({ state: 'detached' }); await source.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'test-results/online-source-settings.png') });
    await page.setViewportSize({ width: 412, height: 915 }); await source.locator('h3').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(root, 'test-results/online-source-mobile.png') });
    await application.close(); application = null;
    page = await launch('device-b'); await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3); await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('[aria-label="在线曲库访问密钥"]')?.value);
    assert.equal(await page.getByLabel('在线曲库访问密钥', { exact: true }).inputValue(), token); assert.deepEqual(errors, []);
    console.log('PASS local real HTTP + Electron IPC: confirmed uploads, 3 demo songs/cover/bilingual lyrics across isolated devices, SHA-256, encrypted credentials/restart, duplicate upload success without overwriting remote edits and no paid AI/renderer errors');
  } finally { if (application) await application.close(); backend.kill(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
