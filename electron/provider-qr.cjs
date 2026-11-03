// Minimal MQTT 5 client for the official QQ Music login push channel.
// Supports only connect/subscribe, bounded incoming publishes, ping and QoS 1 ack.
const crypto = require('node:crypto');
const text = (value) => { const bytes = Buffer.from(value); const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); return Buffer.concat([length, bytes]); };
function variable(value) { const bytes = []; do { let digit = value % 128; value = Math.floor(value / 128); bytes.push(digit | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); }
const packet = (type, body) => Buffer.concat([Buffer.from([type]), variable(body.length), body]);
const property = (name, value) => Buffer.concat([Buffer.from([38]), text(name), text(value)]);
function connect(key) {
  const properties = Buffer.concat([Buffer.from([21]), text('pass'), ...Object.entries({ tmeAppID: 'qqmusic', business: 'management', hashTag: key, clientTag: 'management.user', userID: key }).map(([name, value]) => property(name, value))]);
  return packet(16, Buffer.concat([text('MQTT'), Buffer.from([5, 2, 0, 30]), variable(properties.length), properties, text(`${Date.now()}${crypto.randomInt(1000, 9999)}`)]));
}
function subscribe(key) { const props = Buffer.concat([property('authorization', 'tmelogin'), property('pubsub', 'unicast')]); return packet(130, Buffer.concat([Buffer.from([0, 1]), variable(props.length), props, text(`management.qrcode_login/${key}`), Buffer.from([1])])); }
function reader(bytes) {
  let offset = 0; const read = (size) => { if (offset + size > bytes.length) throw Error('登录消息不完整。'); const value = bytes.subarray(offset, offset + size); offset += size; return value; };
  const integer = () => { let value = 0, factor = 1; for (let i = 0; i < 4; i++) { const digit = read(1)[0]; value += (digit & 127) * factor; if (!(digit & 128)) return value; factor *= 128; } throw Error('登录消息长度无效。'); };
  const string = () => read(read(2).readUInt16BE()).toString('utf8');
  const properties = () => {
    const length = integer(), end = offset + length, value = {};
    if (end > bytes.length) throw Error('登录消息属性不完整。');
    while (offset < end) { const id = read(1)[0]; if (id === 38) { const key = string(); value[key] = string(); } else if ([3, 8, 18, 21, 26, 28, 31].includes(id)) value[id] = string(); else if ([1, 23, 25, 36, 37, 40, 41, 42].includes(id)) read(1); else if ([19, 33, 34, 35].includes(id)) read(2); else if ([2, 17, 24, 39].includes(id)) read(4); else if ([9, 22].includes(id)) read(read(2).readUInt16BE()); else if (id === 11) integer(); else throw Error('不支持的登录消息属性。'); }
    if (offset !== end) throw Error('登录消息属性长度无效。'); return value;
  };
  return { read, integer, string, properties, rest: () => bytes.subarray(offset) };
}
module.exports = function watchQr({ key, onCookies, WebSocket = globalThis.WebSocket, timeout = 900000 }) {
  let socket, timer, ping, buffer = Buffer.alloc(0), redirects = 0, closed = false, settling = false;
  let resolveReady, rejectReady; const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const state = { code: 40000, error: '' };
  const close = () => { closed = true; clearTimeout(timer); clearInterval(ping); rejectReady(Error('扫码连接已关闭。')); try { socket?.send(Buffer.from([224, 0])); socket?.close(); } catch {} };
  const fail = (error) => { state.error = error.message || '扫码实时连接中断，请刷新二维码。'; rejectReady(Error(state.error)); close(); };
  const open = (suffix = '') => {
    socket = new WebSocket(`wss://mu.y.qq.com/ws/handshake${suffix}`, ['mqtt']); socket.binaryType = 'arraybuffer';
    const current = socket;
    socket.addEventListener('open', () => { if (current === socket && !closed) socket.send(connect(key)); });
    socket.addEventListener('error', () => { if (current === socket && !closed) fail(Error('QQ 扫码实时连接失败，请检查网络后刷新二维码。')); });
    socket.addEventListener('close', () => { if (current === socket && !closed) fail(Error('QQ 扫码实时连接已断开，请刷新二维码。')); });
    socket.addEventListener('message', async (event) => {
      if (closed || current !== socket) return;
      try {
        const bytes = Buffer.from(event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer()); buffer = Buffer.concat([buffer, bytes]);
        if (buffer.length > 256 * 1024) throw Error('登录推送过大。');
        while (buffer.length > 1) {
          let length = 0, factor = 1, start = 1, done = false;
          for (; start < buffer.length && start <= 4; start++) { const digit = buffer[start]; length += (digit & 127) * factor; factor *= 128; if (!(digit & 128)) { start++; done = true; break; } }
          if (!done) { if (start > 4) throw Error('登录推送长度无效。'); break; }
          if (length > 256 * 1024) throw Error('登录推送过大。'); if (buffer.length < start + length) break;
          const header = buffer[0], body = buffer.subarray(start, start + length); buffer = buffer.subarray(start + length); const input = reader(body);
          if ((header >> 4) === 2) {
            input.read(1); const reason = input.read(1)[0], props = input.properties();
            if ([156, 157].includes(reason) && props[28] && redirects++ < 3) { socket = null; current.close(); buffer = Buffer.alloc(0); open(`/${encodeURIComponent(props[28])}`); return; }
            if (reason !== 0) throw Error(`QQ 登录实时通道拒绝连接（${reason}）。`); socket.send(subscribe(key));
          } else if ((header >> 4) === 9) { input.read(2); input.properties(); if (input.rest()[0] >= 128) throw Error('QQ 登录实时订阅失败。'); clearTimeout(timer); resolveReady(); ping = setInterval(() => { if (!closed) socket.send(Buffer.from([192, 0])); }, 20000); timer = setTimeout(() => { state.code = 40002; close(); }, timeout); }
          else if ((header >> 4) === 3) {
            const topic = input.string(); const qos = (header >> 1) & 3; const identifier = qos ? input.read(2) : null; const props = input.properties();
            if (qos === 1) socket.send(packet(64, identifier));
            if (topic !== `management.qrcode_login/${key}`) continue;
            const type = props.type;
            if (type === 'scanned') state.code = 40001;
            else if (type === 'timeout' || type === 'canceled') { state.code = 40002; close(); }
            else if (type === 'cookies' && !settling) {
              settling = true; state.code = 40001;
              try { await onCookies(JSON.parse(input.rest().toString('utf8'))); if (!closed) { state.code = 0; close(); } } catch (error) { fail(error); }
            }
          }
        }
      } catch (error) { fail(error); }
    });
  };
  timer = setTimeout(() => fail(Error('QQ 扫码实时连接超时，请刷新二维码。')), 15000);
  try { open(); } catch (error) { fail(error); }
  return { ready, state, close };
};
module.exports.connect = connect; module.exports.subscribe = subscribe; module.exports.reader = reader; module.exports.packet = packet; module.exports.text = text; module.exports.variable = variable; module.exports.property = property;
