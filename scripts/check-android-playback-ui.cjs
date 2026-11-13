const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

async function main() {
  const directory = path.resolve(__dirname, '../dist');
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const filename = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(`${directory}${path.sep}`)) throw Error('Invalid path');
      response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.zip': 'application/zip' }[path.extname(filename)] || 'application/octet-stream');
      response.end(await fs.readFile(filename));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      window.androidBridge = {};
      const methods = {
        DocumentLibrary: ['info'],
        NativePlayback: ['state', 'savedPosition', 'control', 'notifications', 'cached', 'write', 'finish', 'setQueue', 'addListener', 'removeListener'],
        SecureConfig: ['loadKey'],
        AppUpdates: ['config', 'state', 'addListener', 'removeListener'],
        BackgroundTasks: ['begin', 'update', 'finish', 'sourceTasks', 'addListener', 'removeListener'],
        MusicProviders: ['request', 'cancel', 'saveLoginQr', 'openProviderApp'],
      };
      window.Capacitor = {
        PluginHeaders: Object.entries(methods).map(([name, list]) => ({ name, methods: list.map((name) => ({ name, rtype: name === 'addListener' ? 'callback' : 'promise' })) })),
        nativeCallback: () => 'listener',
        nativePromise: async (plugin, method, options = {}) => {
          if (method === 'removeListener') return {};
          if (plugin === 'DocumentLibrary') return { storageMode: 'database', libraryId: 'fixture', trackCount: 0, path: '/private/library', previousPath: '', internalPath: '/private', legacyMigrated: true, moving: false };
          if (plugin === 'SecureConfig') return { key: '', path: '/private/config' };
          if (plugin === 'BackgroundTasks') return {};
          if (plugin === 'MusicProviders') {
            if (method === 'cancel') return {};
            if (method === 'saveLoginQr') { if (localStorage.getItem('mock-qr-denied')) throw Error('未允许保存到相册'); localStorage.setItem('mock-qr-save-count', String(Number(localStorage.getItem('mock-qr-save-count') || 0) + 1)); localStorage.setItem('mock-qr-saved', options.image); return {}; }
            if (method === 'openProviderApp') { localStorage.setItem('mock-provider-opened', options.provider); return {}; }
            if (options.action === 'login-create') return { code: 0, req_0: { code: 0, data: { qrcodeID: 'android-login', qrcode: 'https://y.qq.com/fixture-login', expiresIn: 180 } } };
            if (options.action === 'login-check') return { code: 0, req_0: { code: localStorage.getItem('mock-provider-confirmed') ? 0 : 40000, data: {} } };
            if (options.action === 'session') return { code: 0, req_0: { code: 0, data: localStorage.getItem('mock-provider-confirmed') ? { info: { retCode: 0, nick: '安卓测试账号' } } : {} } };
            if (options.action === 'search') return { code: 0, req_0: { code: 0, data: { body: { item_song: [{ mid: 'android001', title: '安卓在线测试', singer: [{ name: '测试歌手' }], album: { name: '测试' }, interval: 36 }] } } } };
            if (options.action === 'playback') return { code: 0, req_0: { code: 0, data: { sip: ['https://ws.stream.qqmusic.qq.com/'], midurlinfo: [{ purl: 'android.wav' }] } } };
            throw Error('Unexpected provider action: ' + options.action);
          }
          if (plugin === 'AppUpdates') return method === 'config' ? { currentVersion: '1.0.20', platform: 'android', baseUrl: '', autoCheck: false, lastChecked: 0 } : { phase: 'idle', currentVersion: '1.0.20', bytes: 0, total: 0 };
          if (plugin === 'NativePlayback') {
            if (method === 'state') return JSON.parse(localStorage.getItem('mock-native-state') || '{"active":false}');
            if (method === 'savedPosition') {
              const saved = JSON.parse(localStorage.getItem('mock-native-saved') || '{}');
              return saved.scope === options.scope ? saved : {};
            }
            if (method === 'cached') return { ids: options.tracks.map((track) => track.id) };
            if (method === 'setQueue') {
              if (options.updateOnly) localStorage.setItem('mock-queue-edited', 'true');
              localStorage.setItem('mock-native-queue', JSON.stringify(options));
              localStorage.setItem('mock-native-state', JSON.stringify({ active: true, id: options.id, position: options.position, duration: 36, playing: true }));
            }
            return {};
          }
          throw Error(`Unexpected bridge call: ${plugin}.${method}`);
        },
      };
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    assert.match(await page.locator('meta[name=viewport]').getAttribute('content'), /user-scalable=no/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction), 'pan-x pan-y');
    await page.getByRole('button', { name: '先听听示例', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3);
    const ids = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => { const open = indexedDB.open('tingyu-library', 3); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      const tracks = await new Promise((resolve, reject) => { const request = database.transaction('tracks').objectStore('tracks').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      database.close(); return tracks.map((track) => track.id);
    });
    await page.evaluate((ids) => {
      localStorage.setItem('tingyu-current', ids[0]);
      localStorage.setItem('mock-native-state', JSON.stringify({ active: true, id: ids[1], playing: true, position: 17, duration: 36 }));
    }, ids);
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="播放进度"]').value) === 17);
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('mock-native-state')); state.position = 23;
      localStorage.setItem('mock-native-state', JSON.stringify(state));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="播放进度"]').value) === 23);
    await page.evaluate(() => { document.querySelector('audio').dispatchEvent(new Event('seeked')); });
    assert.equal(Number(await page.getByLabel('播放进度', { exact: true }).inputValue()), 23);
    await page.reload();
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="播放进度"]').value) === 23);
    assert.equal(await page.evaluate(() => localStorage.getItem('tingyu-current')), ids[1]);
    console.log('PASS native clock refresh without broadcasts, foreground return, stale WebView seek ignored, reload attaches to the live service');

    await page.evaluate((id) => {
      localStorage.setItem('mock-native-state', '{"active":false}');
      localStorage.setItem('mock-native-saved', JSON.stringify({ scope: 'database', id, position: 24, duration: 36 }));
    }, ids[1]);
    await page.reload();
    await page.waitForFunction(() => Math.abs(document.querySelector('audio').currentTime - 24) < 0.1);
    assert.equal(await page.locator('audio').evaluate((audio) => audio.paused), true);
    assert.equal(Number(await page.getByLabel('播放进度', { exact: true }).inputValue()), 24);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => !!localStorage.getItem('mock-native-queue'));
    const queue = await page.evaluate(() => JSON.parse(localStorage.getItem('mock-native-queue')));
    assert.equal(queue.libraryScope, 'database'); assert.ok(queue.position >= 24 && queue.position < 27);
    console.log('PASS cold restore remains paused at saved time and playback hands that time to the native service');

    await page.evaluate((id) => {
      localStorage.setItem('mock-native-state', '{"active":false}');
      localStorage.setItem('mock-native-saved', JSON.stringify({ scope: 'folder:other', id, position: 31, duration: 36 }));
    }, ids[1]);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.track-row').length === 3 && document.querySelector('audio').readyState >= 1);
    assert.equal(Number(await page.getByLabel('播放进度', { exact: true }).inputValue()), 0);
    const bytes = Buffer.alloc(44 + 16000 * 36); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    await page.route('https://ws.stream.qqmusic.qq.com/**', (route) => route.fulfill({ contentType: 'audio/wav', body: bytes }));
    await page.evaluate(() => localStorage.removeItem('mock-native-queue'));
    await page.getByRole('button', { name: '在线搜索', exact: true }).click(); await page.getByLabel('搜索在线音乐').fill('测试'); await page.locator('.provider-search-form button[type=submit]').click();
    await page.getByRole('button', { name: '扫码登录', exact: true }).click();
    const qr = page.getByRole('button', { name: '保存QQ 音乐登录二维码到相册', exact: true });
    const down = { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 };
    await qr.dispatchEvent('pointerdown', down);
    await qr.dispatchEvent('pointerup', down);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-qr-save-count')), null);
    await qr.dispatchEvent('pointerdown', down);
    await qr.dispatchEvent('pointermove', { ...down, clientY: 130 });
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-qr-save-count')), null);
    await qr.dispatchEvent('pointerdown', down);
    await qr.dispatchEvent('pointercancel', down);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-qr-save-count')), null);
    await qr.dispatchEvent('pointerdown', down);
    await page.waitForFunction(() => localStorage.getItem('mock-qr-save-count') === '1');
    await qr.dispatchEvent('pointerup', down);
    await page.locator('.provider-qr-message').filter({ hasText: '已保存到相册' }).waitFor();
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-qr-save-count')), '1');
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-provider-opened')), null);
    await page.evaluate(() => localStorage.setItem('mock-qr-denied', 'true'));
    await qr.dispatchEvent('pointerdown', down);
    await page.locator('.provider-qr-message').filter({ hasText: '未允许保存到相册' }).waitFor();
    await qr.dispatchEvent('pointerup', down);
    await page.evaluate(() => localStorage.removeItem('mock-qr-denied'));
    console.log('PASS QR long press saves once without launching App; short tap, scrolling and pointer cancel do not save; permission failure shown');
    await page.getByRole('button', { name: '保存二维码并打开 App', exact: true }).click();
    assert.match(await page.evaluate(() => localStorage.getItem('mock-qr-saved')), /^data:image\/png;base64,/);
    assert.equal(await page.evaluate(() => localStorage.getItem('mock-provider-opened')), 'qq');
    await page.evaluate(() => { localStorage.setItem('mock-provider-confirmed', 'true'); document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByText('安卓测试账号', { exact: true }).waitFor();
    console.log('PASS same-phone QR save and official App launch; return immediately verifies session');
    await page.getByRole('button', { name: '在线播放 安卓在线测试', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-native-queue') || '{}').tracks?.some((item) => item.provider === 'qq'));
    const onlineQueue = await page.evaluate(() => JSON.parse(localStorage.getItem('mock-native-queue')));
    assert.equal(onlineQueue.tracks[0].providerTrackId, 'android001'); assert.equal(onlineQueue.tracks[0].sourceUrl, undefined); assert.ok(!JSON.stringify(onlineQueue).includes('https://'));
    await page.getByRole('button', { name: '播放队列', exact: true }).click();
    await page.getByRole('button', { name: '添加歌曲', exact: true }).click();
    await page.locator('.queue-candidate').first().click();
    await page.waitForFunction(() => localStorage.getItem('mock-queue-edited') === 'true');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('mock-native-queue')))).tracks.length, 2);
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    const journal = [{ song: { provider: 'netease', id: '123456', title: '锁屏切歌记录', artist: '歌手', album: '专辑', duration: 180, capabilities: { playback: true, download: true } }, lastPlayed: Date.now() }];
    await page.evaluate((entries) => { const state = JSON.parse(localStorage.getItem('mock-native-state')); state.providerRecent = entries; localStorage.setItem('mock-native-state', JSON.stringify(state)); document.dispatchEvent(new Event('visibilitychange')); }, journal);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('xianqiji-provider-recent-v2') || '[]').some((item) => item.song.id === '123456'));
    await page.getByRole('button', { name: '最近播放', exact: true }).click(); await page.locator('.track-row').filter({ hasText: '锁屏切歌记录' }).waitFor();
    assert.equal(await page.locator('.sidebar .nav-count').first().textContent(), '03');
    console.log('PASS Android external playback hands provider IDs to native service without persisting media URLs; lock-screen play journal recovers Recent without library pollution');
    assert.deepEqual(errors, []);
    const normal = await browser.newPage(); await normal.goto(url);
    assert.doesNotMatch(await normal.locator('meta[name=viewport]').getAttribute('content'), /user-scalable=no/);
    console.log('PASS other-library checkpoint ignored, Android viewport fixed, ordinary browser zoom retained; no renderer errors');
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
