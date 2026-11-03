const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const create = require('../electron/music-providers.cjs');
const base = path.resolve(__dirname, '../test-results');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv); const body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); }, decryptString: (value) => { const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(); } };
async function fixture(fetch) { await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, 'providers-native-')); return { directory, api: create({ directory, safeStorage, fetch }) }; }
const request = (action, provider = 'qq') => ({ id: crypto.randomUUID(), provider, action, data: action === 'login-check' ? { key: 'fixture-qr' } : {} });
test('login is redacted, encrypted, reused after restart and cleared on logout', async () => {
  let sentCookie = '';
  const fetch = async (_url, options) => { sentCookie = options.headers.Cookie; return Response.json({ code: 0, req_0: { code: 0, data: { code: 0, musicid: '123456', musickey: 'fixture-secret-session', refresh_key: 'fixture-refresh' } } }); };
  const { directory, api } = await fixture(fetch);
  const result = await api.request(request('login-check'));
  assert.equal(result.req_0.data.musickey, undefined);
  assert.ok(!(await fs.readFile(path.join(directory, 'config/provider-qq.bin'))).includes(Buffer.from('fixture-secret-session')));
  const reopened = create({ directory, safeStorage, fetch }); await reopened.request(request('session')); assert.ok(sentCookie.includes('qm_keyst=fixture-secret-session'));
  await reopened.request(request('logout')); await reopened.request(request('session')); assert.ok(!sentCookie.includes('fixture-secret-session'));
});
test('QQ push channel receives scan then confirmation, exchanges a native-only token and rejects an oversized frame', async () => {
  const wire = require('../electron/provider-qr.cjs'); let socket; let received; let readyTopic;
  class Socket extends EventTarget {
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    emit(bytes) { this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(bytes).buffer })); }
    send(bytes) {
      if (bytes[0] === 16) queueMicrotask(() => this.emit([32, 3, 0, 0, 0]));
      if (bytes[0] === 130) { const input = wire.reader(Buffer.from(bytes).subarray(1)); input.integer(); const body = wire.reader(input.rest()); body.read(2); assert.equal(body.properties().authorization, 'tmelogin'); readyTopic = body.string(); queueMicrotask(() => this.emit([144, 4, 0, 1, 0, 1])); }
    }
    close() {}
  }
  const watch = wire({ key: 'fixture-qr', WebSocket: Socket, onCookies: async (payload) => { received = payload; } }); await watch.ready; assert.equal(readyTopic, 'management.qrcode_login/fixture-qr');
  const publish = (type, payload) => { const props = wire.property('type', type); return wire.packet(48, Buffer.concat([wire.text(readyTopic), wire.variable(props.length), props, Buffer.from(JSON.stringify(payload))])); };
  socket.emit(publish('scanned', {})); assert.equal(watch.state.code, 40001);
  socket.emit(publish('cookies', { cookies: { qqmusic_key: { value: 'fixture-push-token' } } })); await new Promise((resolve) => setImmediate(resolve)); assert.equal(received.cookies.qqmusic_key.value, 'fixture-push-token'); assert.equal(watch.state.code, 0);
  const oversized = wire({ key: 'fixture-qr', WebSocket: Socket, onCookies: async () => {} }); await oversized.ready; socket.emit(Buffer.concat([Buffer.from([48]), wire.variable(256 * 1024 + 1)])); assert.match(oversized.state.error, /过大/); oversized.close();
});
test('a late login response cannot restore an account after logout', async () => {
  let finish, started; const ready = new Promise((resolve) => { started = resolve; });
  const { api, directory } = await fixture(async () => { started(); return new Promise((resolve) => { finish = resolve; }); });
  const pending = api.request(request('session')); await ready; await api.request(request('logout'));
  finish(Response.json({ code: 0 }, { headers: { 'Set-Cookie': 'qm_keyst=fixture-late; Path=/' } }));
  await assert.rejects(pending, /退出/); await assert.rejects(fs.stat(path.join(directory, 'config/provider-qq.bin')), { code: 'ENOENT' });
});
test('download validates redirects and length, preserves completed IDs and removes cancelled files', async () => {
  let mode = 'good'; const bytes = Buffer.from('fixture audio bytes');
  const { api, directory } = await fixture(async (_url, options) => {
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://attacker.example/song.mp3' } });
    if (mode === 'cancel') return new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(Error('cancelled')), { once: true }); controller.enqueue(bytes); } }));
    return new Response(bytes, { headers: { 'content-length': String(bytes.length + (mode === 'short' ? 1 : 0)) } });
  });
  const input = () => ({ id: crypto.randomUUID(), provider: 'qq', url: 'https://ws.stream.qqmusic.qq.com/song.mp3' });
  const completed = input(); const result = await api.download(completed);
  await assert.rejects(api.download(completed), /下载标识/); assert.deepEqual(await api.readDownload(result.token, 0, bytes.length), bytes); await api.removeDownload(result.token);
  mode = 'redirect'; await assert.rejects(api.download(input()), /不属于/);
  mode = 'short'; await assert.rejects(api.download(input()), /不完整/);
  mode = 'cancel'; const cancelled = input(); const pending = api.download(cancelled); await new Promise((resolve) => setTimeout(resolve, 20)); api.cancel(cancelled.id); await assert.rejects(pending);
  assert.deepEqual(await fs.readdir(path.join(directory, 'Temp/provider-downloads')), []);
});
