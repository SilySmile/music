// Exercise the installed app's renderer -> IPC -> native transport -> storage path.
// Only the platform HTTP boundary is replaced with documented response fixtures.
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
async function main() {
  const root = path.resolve(__dirname, '..'); const directory = path.join(root, 'test-results', `providers-${Date.now()}`); const profile = path.join(directory, 'profile');
  await fs.mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(44 + 16000 * 10); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const mp3Bytes = Buffer.alloc(417 * 450); for (let index = 0; index < 450; index++) { const offset = index * 417; mp3Bytes[offset] = 0xff; mp3Bytes[offset + 1] = 0xfb; mp3Bytes[offset + 2] = 0x90; }
  const serverToken = 'fixture-provider-server-writer'; const auth = path.join(directory, 'auth.json');
  await fs.writeFile(auth, JSON.stringify({ publicRead: true, writers: [crypto.createHash('sha256').update(serverToken).digest('hex')], readers: [] }));
  const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  const backend = spawn(process.env.PYTHON_EXE || 'python', [path.join(root, 'deployment/library-server.py')], { cwd: root, env: { ...process.env, XQ_LIBRARY_DATA: path.join(directory, 'server'), XQ_LIBRARY_AUTH: auth, XQ_LIBRARY_PORT: String(port), PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, stdio: 'ignore' });
  let application; const errors = [];
  async function launch() {
    const env = { ...process.env, TINGYU_TEST: '1', TINGYU_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: process.env.TINGYU_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.TINGYU_EXECUTABLE ? [] : [root], env, cwd: root, timeout: 60000 });
    await application.evaluate(({ net, app }, fixture) => {
      const original = net.fetch.bind(net); const audio = Uint8Array.from(fixture.bytes); const mp3Audio = Uint8Array.from(fixture.mp3Bytes);
      const wire = process.mainModule.require(process.mainModule.require('node:path').join(app.getAppPath(), 'electron/provider-qr.cjs'));
      globalThis.WebSocket = class extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        emit(bytes) { const value = Uint8Array.from(bytes); this.dispatchEvent(new MessageEvent('message', { data: value.buffer })); }
        send(bytes) {
          if (bytes[0] === 16) queueMicrotask(() => this.emit([32, 3, 0, 0, 0]));
          if (bytes[0] === 130) {
            const input = wire.reader(Buffer.from(bytes).subarray(1)); input.integer(); const body = wire.reader(input.rest()); body.read(2); body.properties(); const topic = body.string();
            queueMicrotask(() => { this.emit([144, 4, 0, 1, 0, 1]);
              if (globalThis.providerFixture.login) setTimeout(() => { const props = wire.property('type', 'cookies'); this.emit(wire.packet(48, Buffer.concat([wire.text(topic), wire.variable(props.length), props, Buffer.from(JSON.stringify({ cookies: { qqmusic_uin: { value: '123456' }, qqmusic_key: { value: 'fixture-one-time-exchange' } } }))]))); }, 50);
            });
          }
        }
        close() {}
      };
      globalThis.providerFixture = { mode: 'good', login: true, mediaCalls: 0, serverCalls: [] };
      const envelope = (data, code = 0) => Response.json({ code: 0, req_0: { code, ...(data ? { data } : {}) } });
      net.fetch = async (url, options = {}) => {
        const target = new URL(url); const state = globalThis.providerFixture;
        if (target.origin === 'https://providers.fixture.test') { state.serverCalls.push(target.pathname); return original(fixture.endpoint + target.pathname.slice(4) + target.search, options); }
        if (target.hostname === 'u.y.qq.com') {
          const request = JSON.parse(options.body); const { method, param } = request.req_0;
          if (method === 'GetLoginUserInfo') return String(options.headers.Cookie).includes('qm_keyst=fixture-private-session') ? envelope({ info: { retCode: 0, nick: '测试 QQ 用户' } }) : envelope(null, 1000);
          if (method === 'Login') { if (param.token !== 'fixture-one-time-exchange') throw Error('Wrong QR exchange token'); return envelope({ musicid: '123456', musickey: 'fixture-private-session', refresh_key: 'fixture-private-refresh' }); }
          if (method === 'CreateQRCode') return envelope({ qrcodeID: 'fixture-qrcode', qrcode: 'https://y.qq.com/fixture-login', expiresIn: 180 });
          if (method === 'CheckQRCode') return state.login ? envelope({ musicid: '123456', musickey: 'fixture-private-session', refresh_key: 'fixture-private-refresh' }) : envelope(null, 40000);
          if (method === 'DoSearchForQQMusicMobile' && param.query === '分页') {
            if (state.searchFailOnce && param.page_num === 2) { state.searchFailOnce = false; return envelope(null, 500); }
            return envelope({ body: { item_song: Array.from({length:param.page_num === 3 ? 3 : 20}, (_,i) => ({mid:'page'+((param.page_num-1)*20+i),title:'分页歌曲 '+((param.page_num-1)*20+i),singer:[{name:'测试歌手'}],album:{name:'分页测试'},interval:10})) } });
          }
          if (method === 'DoSearchForQQMusicMobile') return envelope({ body: { item_song: [{ mid: 'fixture001', title: '测试在线歌曲', singer: [{ name: '测试歌手' }], album: { name: '测试专辑' }, interval: 10 }] } });
          if (method === 'get_song_detail_yqq') return envelope({ track_info: { pay: { pay_down: state.mode === 'paid' ? 1 : 0 } } });
          if (method === 'CgiGetVkey' || method === 'UrlGetVkey') { state.mediaCalls++; return envelope({ sip: ['https://ws.stream.qqmusic.qq.com/'], midurlinfo: [{ purl: state.mode === 'denied' ? '' : state.mode === 'preview' ? 'RS02fixture.wav' : method === 'UrlGetVkey' ? param.filename[0] : `${param.songmid[0]}.wav`, type: method === 'UrlGetVkey' ? 'mp3' : 'wav' }] }); }
          throw Error('Unexpected QQ method: ' + method);
        }
        if (['music.163.com', 'interfacepc.music.163.com'].includes(target.hostname)) {
          if (target.pathname.includes('cloudsearch')) return Response.json({ code: 200, result: { songs: [{ id: 1234567, name: '测试网易歌曲', ar: [{ name: '网易歌手' }], al: { name: '测试专辑' }, dt: 10000 }] } });
          if (target.pathname.includes('nuser/account')) return Response.json({ code: 200, ...(String(options.headers.Cookie).includes('MUSIC_U=fixture-netease-session') ? { account: { id: 123 }, profile: { nickname: '测试网易用户' } } : {}) });
          if (target.pathname.includes('qrcode/unikey')) return Response.json({ code: 200, unikey: 'fixture-netease-qr' });
          if (target.pathname.includes('qrcode/client/login')) { state.neteaseChecks = (state.neteaseChecks || 0) + 1; if (state.neteaseDenied) return Response.json({ code: 8821, message: '请切换其他登录方式或升级新版本再试' }); if (state.neteaseChecks === 1) return Response.json({ code: 802 }); return Response.json({ code: 803 }, { headers: { 'Set-Cookie': 'MUSIC_U=fixture-netease-session; Path=/; Secure; HttpOnly' } }); }
          if (target.pathname.includes('download/url')) return Response.json({ code: 200, data: { code: 200, url: 'https://m801.music.126.net/fixture.mp3', type: 'mp3', freeTrialInfo: state.mode === 'preview' ? { start: 0, end: 5 } : null } });
          if (target.pathname.includes('player/url')) return Response.json({ code: 200, data: [{ code: 200, url: 'https://m801.music.126.net/fixture.wav', type: 'wav' }] });
          throw Error('Unexpected NetEase route: ' + target.pathname);
        }
        if (['ws.stream.qqmusic.qq.com', 'm801.music.126.net'].includes(target.hostname)) {
          state.mediaCalls++;
          if (state.mode === 'slow') await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1500); options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Error('cancelled')); }, { once: true }); });
          const source = target.pathname.endsWith('.mp3') ? mp3Audio : audio;
          return new Response(state.mode === 'corrupt' ? '<html>not audio</html>' : source, { headers: { 'content-type': target.pathname.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', 'content-length': String(state.mode === 'corrupt' ? 22 : source.length) } });
        }
        if (target.hostname === 'lrclib.net') return Response.json([{ id: 1, trackName: '测试在线歌曲', artistName: '测试歌手', duration: 10, syncedLyrics: '[00:00.00]测试歌词第一句\n[00:05.00]测试歌词第二句' }]);
        if (target.hostname === '39.106.55.218') throw Error('No production source in tests');
        return original(url, options);
      };
    }, { bytes: Array.from(bytes), mp3Bytes: Array.from(mp3Bytes), endpoint });
    const page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', (error) => errors.push(error.message));
    for (const host of ['ws.stream.qqmusic.qq.com', 'm801.music.126.net']) await page.route(`https://${host}/**`, (route) => route.fulfill({ status: 200, contentType: route.request().url().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', body: route.request().url().endsWith('.mp3') ? mp3Bytes : bytes }));
    await page.getByRole('button', { name: '在线搜索', exact: true }).first().click(); return page;
  }
  const state = async (values) => application.evaluate((_electron, values) => Object.assign(globalThis.providerFixture, values), values);
  const library = async (page) => page.evaluate(() => window.tingyuDesktop.listLibraryTracks());
  async function search(page) { await page.getByLabel('搜索在线音乐').fill('测试'); await page.locator('.provider-search-form').getByRole('button', { name: '搜索', exact: true }).click(); await page.locator('.provider-result').waitFor(); }
  async function download(page, title) { await page.getByRole('button', { name: `下载 ${title}`, exact: true }).click(); }
  try {
    for (let count = 0; count < 100; count++) { if (await fetch(endpoint + '/info').then((response) => response.ok, () => false)) break; if (backend.exitCode !== null) throw Error('Fixture server failed'); await new Promise((resolve) => setTimeout(resolve, 100)); }
    let page = await launch();
    await page.getByRole('button', { name: '扫码登录', exact: true }).click(); await page.getByText('测试 QQ 用户', { exact: true }).waitFor();
    const encrypted = await fs.readFile(path.join(profile, 'config/provider-qq.bin')); assert.ok(!encrypted.includes(Buffer.from('fixture-private-session')));
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('fixture-private-session'));
    await search(page); await page.getByRole('button', { name: '查看歌词 测试在线歌曲', exact: true }).click(); await page.getByText('测试歌词第一句', { exact: true }).waitFor(); assert.equal((await library(page)).length, 0);
    await state({ mode: 'denied' }); await page.getByRole('button', { name: '在线播放 测试在线歌曲', exact: true }).click(); await page.locator('.provider-status').filter({ hasText: '未提供' }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xianqiji-provider-recent-v2') || '[]').length), 0);
    await state({ mode: 'good' }); await page.getByRole('button', { name: '在线播放 测试在线歌曲', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > .1);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('xianqiji-provider-recent-v2') || '[]').length === 1);
    assert.equal((await library(page)).length, 0);
    await page.getByRole('button', { name: '最近播放', exact: true }).first().click(); await page.locator('.track-row').filter({ hasText: '测试在线歌曲' }).waitFor();
    await page.locator('.lyrics-card .lyric-line').filter({ hasText: '测试歌词第一句' }).waitFor();
    await page.locator('.sidebar nav button').first().click(); assert.equal(await page.locator('.track-row:visible').count(), 0);
    console.log('PASS real playback records Recent only; search and failed playback never enter library or history');
    await page.getByRole('button', { name: '在线搜索', exact: true }).first().click();
    for (const [mode, expected] of [['paid', '未标记'], ['preview', '试听'], ['corrupt', '未加入音乐库']]) { await state({ mode }); await download(page, '测试在线歌曲'); await page.locator('.provider-status').filter({ hasText: expected }).waitFor(); assert.equal((await library(page)).length, 0); }
    await state({ mode: 'slow' }); await download(page, '测试在线歌曲'); await page.getByRole('button', { name: '停止', exact: true }).click(); await page.locator('.provider-status').filter({ hasText: '已停止' }).waitFor(); assert.equal((await library(page)).length, 0);
    await state({ mode: 'good' }); await download(page, '测试在线歌曲'); await page.locator('.provider-status').filter({ hasText: '已保存到本地' }).waitFor();
    const saved = (await library(page))[0]; assert.equal(saved.metadata.external, undefined); assert.equal(saved.metadata.format, 'MP3'); assert.equal(saved.metadata.id, crypto.createHash('sha256').update(mp3Bytes).digest('hex')); assert.equal(saved.metadata.lyrics[0].text, '测试歌词第一句');
    await page.evaluate(async (id) => { await window.tingyuDesktop.patchLibraryTrack(id, { favorite: true, lyrics: [{ time: 0, text: '保留我的歌词' }] }); }, saved.metadata.id);
    await download(page, '测试在线歌曲'); await page.locator('.provider-status').filter({ hasText: '已保存到本地' }).waitFor();
    const repeated = await library(page); assert.equal(repeated.length, 1); assert.equal(repeated[0].metadata.favorite, true); assert.equal(repeated[0].metadata.lyrics[0].text, '保留我的歌词');
    await page.getByRole('button', { name: '最近播放', exact: true }).first().click(); assert.equal(await page.locator('.track-row:visible').count(), 1);
    console.log('PASS permission, preview, invalid audio and cancel fail closed; complete download deduplicates and preserves favorite/lyrics');
    await page.getByRole('button', { name: '在线搜索', exact: true }).first().click();
    await page.getByRole('button', { name: '网易云音乐', exact: true }).click();
    await state({ neteaseDenied: true }); await page.getByRole('button', { name: '扫码登录', exact: true }).click();
    await page.locator('.provider-status').filter({ hasText: '8821' }).waitFor(); assert.equal(await page.locator('.provider-login-code').count(), 0);
    await state({ neteaseDenied: false, neteaseChecks: 0 }); await page.getByRole('button', { name: '扫码登录', exact: true }).click();
    await page.locator('.provider-status').filter({ hasText: '已检测到扫码' }).waitFor(); await page.getByText('测试网易用户', { exact: true }).waitFor();
    await search(page); await page.getByRole('button', { name: '在线播放 测试网易歌曲', exact: true }).click(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('xianqiji-provider-recent-v2') || '[]').length === 2);
    await page.evaluate(async (token) => { await window.tingyuDesktop.saveSourceConfig({ baseUrl: 'https://providers.fixture.test/api/', token, remember: true, connected: true, autoSync: false }); window.dispatchEvent(new Event('xianqiji-source-config-changed')); }, serverToken);
    await page.getByRole('button', { name: '个人服务器', exact: true }).click(); await download(page, '测试网易歌曲'); await page.locator('.provider-status').filter({ hasText: '已保存到个人服务器' }).waitFor();
    const serverInfo = await fetch(endpoint + '/info').then((response) => response.json()); assert.equal(serverInfo.trackCount, 1); assert.equal((await library(page)).length, 1);
    await state({ mode: 'slow', serverCalls: [] }); await download(page, '测试网易歌曲');
    await page.evaluate(async (token) => { await window.tingyuDesktop.saveSourceConfig({ baseUrl: 'https://other.fixture.test/api/', token, remember: true, connected: true, autoSync: false }); }, serverToken);
    await page.locator('.provider-status').filter({ hasText: '目标已变化' }).waitFor();
    assert.ok(!(await application.evaluate(() => globalThis.providerFixture.serverCalls)).some((route) => route.includes('/uploads')));
    console.log('PASS NetEase playback, device QR cookie capture and real personal-server commit; target change stops wrong-server upload');
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(root, 'test-results/providers-mobile.png') });
    await application.close(); application = undefined; page = await launch(); await page.getByText('测试 QQ 用户', { exact: true }).waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.locator('.provider-status').filter({ hasText: '已清除' }).waitFor(); await assert.rejects(fs.stat(path.join(profile, 'config/provider-qq.bin')), { code: 'ENOENT' });
    await page.getByRole('button', { name: '网易云音乐', exact: true }).click(); await page.getByText('测试网易用户', { exact: true }).waitFor(); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.locator('.provider-status').filter({ hasText: '已清除' }).waitFor();
    await page.getByRole('button', {name:'QQ 音乐',exact:true}).click();
    await state({ searchFailOnce: true });
    await page.getByLabel('搜索在线音乐').fill('分页');
    await page.locator('.provider-search-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelectorAll('.provider-result').length === 20);
    await page.locator('.provider-results .load-more').scrollIntoViewIfNeeded();
    await page.getByRole('button', {name:'加载失败，点击重试',exact:true}).waitFor();
    await page.getByRole('button', {name:'加载失败，点击重试',exact:true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.provider-result').length === 40);
    await page.locator('.provider-results .load-more').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.provider-result').length === 43);
    assert.equal(await page.locator('.provider-result-info strong').first().textContent(), '分页歌曲 0');
    await page.getByRole('button', {name:'清除在线搜索',exact:true}).click();
    assert.equal(await page.getByLabel('搜索在线音乐').inputValue(), '');
    await page.locator('.provider-search-history button').filter({hasText:'分页'}).click();
    await page.waitForFunction(() => document.querySelectorAll('.provider-result').length === 20);
    console.log('PASS online scroll append retains preceding songs, stops at end, failed page needs explicit retry, clear input and search history');
    assert.deepEqual(errors, []); console.log('PASS both accounts survive native restart and clear independently; mobile layout has no overflow; no renderer errors');
  } catch (error) { const page = application && (await application.windows())[0]; if (page) { console.error(await page.locator('.provider-status').textContent().catch(() => '')); await page.screenshot({ path: path.join(root, 'test-results/providers-failure.png') }).catch(() => {}); } throw error; }
  finally { await application?.close().catch(() => {}); backend.kill(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
