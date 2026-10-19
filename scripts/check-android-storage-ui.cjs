const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'dist');
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const filename = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(`${directory}${path.sep}`)) throw new Error('Invalid path');
      const content = await fs.readFile(filename);
      response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.zip': 'application/zip' }[path.extname(filename)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      window.androidBridge = {};
      let uploads = new Map();
      let records = JSON.parse(localStorage.getItem('mock-library-records') || '[]');
      const folderInfo = () => ({ storageMode: localStorage.getItem('mock-library-active') ? 'folder' : 'database', uri: localStorage.getItem('mock-library-active') ? 'content://fixture/tree/music' : '', libraryId: 'fixture-library', path: localStorage.getItem('mock-library-active') ? '/storage/emulated/0/Music/弦栖霁音乐库' : '/data/user/0/com.tingyu.music/app_webview/（系统管理的 IndexedDB）', internalPath: '/data/user/0/com.tingyu.music', previousPath: '', legacyMigrated: true, moving: false, trackCount: records.length, databaseName: 'tingyu-library', error: localStorage.getItem('mock-library-permission-error') ? '目录授权失效' : undefined });
      const methods = {
        DocumentLibrary: ['info', 'choose', 'create', 'activate', 'useDatabase', 'list', 'begin', 'write', 'finish', 'cancel', 'read', 'patch', 'remove', 'cache', 'addListener', 'removeListener'],
        NativePlayback: ['state', 'control', 'addListener', 'removeListener'],
        SecureConfig: ['loadKey'],
        AppUpdates: ['config', 'state', 'addListener', 'removeListener'],
        BackgroundTasks: ['begin', 'update', 'finish', 'sourceTasks', 'addListener', 'removeListener'],
      };
      const count = (key) => localStorage.setItem(`mock-${key}`, String(Number(localStorage.getItem(`mock-${key}`) || 0) + 1));
      window.Capacitor = {
        PluginHeaders: Object.entries(methods).map(([name, list]) => ({ name, methods: list.map((name) => ({ name, rtype: name === 'addListener' ? 'callback' : 'promise' })) })),
        nativeCallback: () => 'listener',
        nativePromise: async (plugin, method, options = {}) => {
          if (method === 'removeListener') return {};
          if (plugin === 'BackgroundTasks') { count(`background-${method}`); return {}; }
          if (plugin === 'NativePlayback') return { active: false };
          if (plugin === 'SecureConfig') return { key: '', path: '/private/no_backup/config/ai-config.json' };
          if (plugin === 'AppUpdates') return method === 'config' ? { currentVersion: '1.0.2', platform: 'android', baseUrl: 'https://updates.example/music/', autoCheck: false, lastChecked: 0 } : { phase: 'idle', currentVersion: '1.0.2', bytes: 0, total: 0 };
          if (plugin !== 'DocumentLibrary') throw Error('Unexpected native call');
          if (method === 'info') return folderInfo();
          if (method === 'choose') { window.mockSelection = options.mode; return { token: 'selected', path: '/storage/emulated/0/Music/弦栖霁音乐库', uri: 'content://fixture/tree/music', trackCount: options.mode === 'existing' ? records.length : 0 }; }
          if (method === 'create') { records = []; return {}; }
          if (method === 'begin') { const token = crypto.randomUUID(); uploads.set(token, { metadata: options.metadata, audio: options.audio, cover: options.cover, coverData: '' }); return { token }; }
          if (method === 'write') {
            if (localStorage.getItem('mock-library-copy-error')) throw Error('模拟磁盘写入失败');
            count('write-count'); const upload = uploads.get(options.token); if (options.kind === 'cover') upload.coverData += atob(options.data); return {};
          }
          if (method === 'finish') {
            const upload = uploads.get(options.token);
            const record = { metadata: upload.metadata, audio: { ...upload.audio, file: 'audio.wav', sha256: options.hashes.audio } };
            if (upload.cover) { record.cover = { ...upload.cover, file: 'cover.svg', sha256: options.hashes.cover }; record.coverData = btoa(upload.coverData); }
            records.push(record); uploads.delete(options.token); return record;
          }
          if (method === 'cancel') { uploads.delete(options.token); return {}; }
          if (method === 'activate') {
            count('activate-count'); localStorage.setItem('mock-library-active', 'true'); localStorage.removeItem('mock-library-permission-error');
            localStorage.setItem('mock-library-records', JSON.stringify(records)); return folderInfo();
          }
          if (method === 'useDatabase') { localStorage.removeItem('mock-library-active'); return folderInfo(); }
          if (method === 'list') return { tracks: records.map(({ coverData, ...record }) => record) };
          if (method === 'read') {
            const record = records.find((record) => record.metadata.id === options.id);
            if (options.kind !== 'cover') throw Error('UI must not eagerly read full audio');
            return { data: btoa(atob(record.coverData).slice(options.offset, options.offset + options.length)) };
          }
          if (method === 'cache') { if (options.entries) localStorage.setItem('mock-cache', JSON.stringify(options.entries)); return { entries: JSON.parse(localStorage.getItem('mock-cache') || '[]') }; }
          throw Error(`Unexpected method ${method}`);
        },
      };
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: '先听听示例', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    const settings = () => page.getByRole('button', { name: '偏好设置', exact: true }).click();
    await settings();
    await page.getByLabel('当前音乐库路径', { exact: true }).waitFor();
    assert.ok((await page.getByLabel('当前音乐库路径', { exact: true }).inputValue()).includes('/data/user/0/com.tingyu.music/'));
    await page.getByRole('button', { name: '复制到自选目录', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-activate-count')), null);
    await page.getByRole('button', { name: '复制到自选目录', exact: true }).click();
    await page.evaluate(() => localStorage.setItem('mock-library-copy-error', 'true'));
    await page.getByRole('button', { name: '复制、校验并切换', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '模拟磁盘写入失败' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-activate-count')), null);
    assert.equal(await page.locator('.track-row').count(), 3);
    await page.evaluate(() => localStorage.removeItem('mock-library-copy-error'));
    await page.getByRole('button', { name: '复制到自选目录', exact: true }).click();
    await page.getByRole('button', { name: '复制、校验并切换', exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('mock-library-active') === 'true' && document.querySelectorAll('.track-row').length === 3 && !document.querySelector('.settings-content'));
    await settings();
    await page.getByLabel('音乐库授权地址', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('当前音乐库路径', { exact: true }).inputValue(), '/storage/emulated/0/Music/弦栖霁音乐库');
    await page.locator('.storage-settings').scrollIntoViewIfNeeded();
    await page.locator('.startup-screen').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(root, 'test-results/android-library-directory.png') });
    const writes = await page.evaluate(() => localStorage.getItem('mock-write-count'));
    await page.getByRole('button', { name: '打开已有音乐库', exact: true }).click();
    await page.getByRole('button', { name: '核验并打开此音乐库', exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('mock-activate-count') === '2' && document.querySelectorAll('.track-row').length === 3 && !document.querySelector('.settings-content'));
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-write-count')), writes);
    await page.evaluate(() => localStorage.setItem('mock-library-permission-error', 'true'));
    await page.reload(); await settings();
    await page.locator('.storage-error').filter({ hasText: '目录授权失效' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开已有音乐库', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '打开已有音乐库', exact: true }).click();
    await page.getByRole('button', { name: '核验并打开此音乐库', exact: true }).click();
    await page.waitForFunction(() => !localStorage.getItem('mock-library-permission-error') && document.querySelectorAll('.track-row').length === 3 && !document.querySelector('.settings-content'));
    await settings();
    await page.getByText('内部设置、旧库与后台播放副本', { exact: true }).click();
    await page.getByRole('button', { name: '切回保留的内部曲库', exact: true }).click();
    await page.waitForFunction(() => !localStorage.getItem('mock-library-active') && document.querySelectorAll('.track-row').length === 3 && !document.querySelector('.settings-content'));
    assert.deepEqual(errors, []);
    console.log('PASS Android UI (mocked native SAF): real ZIP to internal DB, visible path/URI, cancel, copy failure retains source, copy/reload, no-import open, lost-permission recovery, return to intact internal library, no renderer errors');
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
