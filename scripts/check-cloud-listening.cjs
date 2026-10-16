const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'test-results', `cloud-listening-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const token = 'fixture-writer-never-production';
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const auth = path.join(directory, 'auth.json');
  await fs.writeFile(auth, JSON.stringify({ publicRead: true, writers: [hash(token)], readers: [] }));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  const backend = spawn(process.env.PYTHON_EXE || 'python', [path.join(root, 'deployment/library-server.py')], { cwd: root, env: { ...process.env, XQ_LIBRARY_DATA: path.join(directory, 'server'), XQ_LIBRARY_AUTH: auth, XQ_LIBRARY_PORT: String(port), PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, stdio: 'ignore' });
  let application;
  const errors = [];
  const mediaRequests = [];
  const request = async (route, body) => {
    const response = await fetch(endpoint + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200);
    return response.json();
  };
  async function launch(name) {
    const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: path.join(directory, name) };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root });
    await application.evaluate(({ net }, endpoint) => {
      const original = net.fetch.bind(net);
      globalThis.fixtureRequests = [];
      net.fetch = async (url, options) => {
        const target = new URL(url);
        if (target.origin === 'https://cloud.fixture.test') {
          globalThis.fixtureRequests.push({ path: target.pathname, authorization: options.headers.Authorization });
          if (target.pathname.endsWith('/media/audio')) await new Promise((resolve) => setTimeout(resolve, 500));
          return original(endpoint + target.pathname.slice(4) + target.search, options);
        }
        if (target.pathname.endsWith('/chat/completions')) throw Error('No paid AI in tests');
        return original(url, options);
      };
    }, endpoint);
    const page = await application.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://cloud.fixture.test/**', async (route) => {
      const target = new URL(route.request().url());
      mediaRequests.push(target.pathname);
      const headers = {};
      const range = route.request().headers().range;
      if (range) headers.Range = range;
      const response = await fetch(endpoint + target.pathname.slice(4) + target.search, { headers });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    return page;
  }
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(endpoint + '/info').then((response) => response.ok, () => false)) { healthy = true; break; }
      if (backend.exitCode !== null) throw Error('Fixture backend exited');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(healthy);
    let page = await launch('seed');
    await page.getByRole('button', { name: '先听听示例', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    const library = await page.evaluate(() => window.tingyuDesktop.getLibraryInfo());
    const records = await page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
    for (const record of records) {
      const task = await request('/uploads', { metadata: record.metadata, audio: record.audio, cover: record.cover, expectedRevision: 0 });
      for (const kind of ['audio', 'cover']) if (record[kind]) {
        const content = await fs.readFile(path.join(library.path, '歌曲', record.metadata.id, record[kind].file));
        for (let offset = 0; offset < content.length; offset += 1024 * 1024) await request(`/uploads/${task.id}/chunk`, { kind, offset, data: content.subarray(offset, offset + 1024 * 1024).toString('base64') });
      }
      await request(`/uploads/${task.id}/finish`, {});
    }
    await application.close(); application = null;
    page = await launch('listener');
    await page.getByRole('button', { name: '偏好设置', exact: true }).first().click();
    const source = page.locator('.online-source-settings');
    await page.waitForFunction(() => document.querySelector('[aria-label="在线音源链接"]')?.value);
    await source.getByLabel('在线音源链接', { exact: true }).fill('https://cloud.fixture.test/api/');
    assert.equal(await source.getByLabel('在线曲库访问密钥', { exact: true }).inputValue(), '');
    await source.getByRole('button', { name: '连接云端音乐', exact: true }).click();
    await source.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    assert.equal((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).length, 0);
    assert.equal(mediaRequests.filter((route) => route.endsWith('/stream/audio')).length, 0);
    await page.locator('.track-row').first().locator('.track-name').click();
    await page.locator('.track-row').first().locator('.favorite').click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.1);
    await page.waitForFunction(async () => (await window.tingyuDesktop.listLibraryTracks()).length === 1);
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.4 && document.querySelector('audio').src.startsWith('xianqiji:'));
    const saved = (await page.evaluate(() => window.tingyuDesktop.listLibraryTracks()))[0];
    assert.equal(saved.metadata.favorite, true);
    const currentLibrary = await page.evaluate(() => window.tingyuDesktop.getLibraryInfo());
    const original = records.find((record) => record.metadata.id === saved.metadata.id);
    assert.deepEqual(saved.metadata.lyrics, original.metadata.lyrics);
    const folder = path.join(currentLibrary.path, '歌曲', saved.metadata.id);
    assert.equal(hash(await fs.readFile(path.join(folder, saved.audio.file))), saved.metadata.id);
    assert.ok((await fs.readdir(folder)).some((file) => file.endsWith('.zh.lrc')));
    const requests = await application.evaluate(() => globalThis.fixtureRequests);
    assert.ok(requests.every((request) => request.authorization === undefined));
    assert.ok(requests.filter((request) => request.path.endsWith('/media/audio')).every((request) => request.path.includes(saved.metadata.id)));
    assert.ok(mediaRequests.some((route) => route.endsWith('/stream/audio')));
    assert.equal(await page.locator('.track-row .format-tag').filter({ hasText: '本地' }).count(), 1);
    await page.locator('.startup-screen').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(directory, 'heard-song-in-local-library.png') });
    await application.close(); application = null;
    backend.kill();
    page = await launch('listener');
    await page.waitForSelector('.track-row');
    await page.locator('.track-row').first().locator('.track-name').click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.2);
    assert.equal((await page.evaluate(() => window.tingyuDesktop.listLibraryTracks())).length, 1);
    assert.deepEqual(errors, []);
    console.log('PASS anonymous address-only connection; cloud catalog without bulk audio download; real HTTPS streaming; only heard song cached with verified audio/cover/Chinese lyrics in current local library; playback survives stream-to-local replacement and offline restart; no paid AI or user files');
  } finally { if (application) await application.close().catch(() => {}); backend.kill(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
