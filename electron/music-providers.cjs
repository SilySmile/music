const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Protocol references: qqmusic-api-enhanced 1.0.8 (MIT),
// @neteasecloudmusicapienhanced/api 4.41.1 (MIT). See provider-notices.txt.
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
function weapi(value, secret = crypto.randomBytes(16).toString('hex').slice(0, 16)) {
  const aes = (text, key) => { const cipher = crypto.createCipheriv('aes-128-cbc', key, '0102030405060708'); return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64'); };
  const input = Buffer.alloc(128); Buffer.from([...secret].reverse().join('')).copy(input, 128 - 16);
  return new URLSearchParams({ params: aes(aes(JSON.stringify(value), '0CoJUm6Qyw8W8jud'), secret), encSecKey: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_NO_PADDING }, input).toString('hex') }).toString();
}
function buildRequest(request, cookie) {
  const { provider, action, data = {} } = request || {};
  if (!['qq', 'netease'].includes(provider)) throw Error('无效音乐平台。');
  const id = String(data.id || '');
  if (['detail', 'playback', 'download'].includes(action) && !(provider === 'qq' ? /^[a-zA-Z0-9]{1,40}$/ : /^\d{1,20}$/).test(id)) throw Error('歌曲标识无效。');
  const query = String(data.query || '').trim(); const page = Math.max(1, Math.min(1000, Math.floor(Number(data.page) || 1)));
  if (action === 'search' && (!query || query.length > 200)) throw Error('搜索内容无效。');
  if (action === 'login-check' && !/^[a-zA-Z0-9_-]{1,200}$/.test(String(data.key || ''))) throw Error('扫码会话无效。');
  if (provider === 'netease') {
    const routes = {
      search: ['/api/cloudsearch/pc', { s: query, type: 1, limit: 20, offset: (page - 1) * 20, total: true }],
      'login-create': ['/api/login/qrcode/unikey', { type: 3 }],
      'login-check': ['/api/login/qrcode/client/login', { key: data.key, type: 3 }],
      session: ['/api/w/nuser/account/get', {}],
      detail: ['/api/v3/song/detail', { c: JSON.stringify([{ id }]) }],
      playback: ['/api/song/enhance/player/url/v1', { ids: JSON.stringify([id]), level: 'standard', encodeType: 'mp3' }],
      download: ['/api/song/enhance/download/url', { id, br: 128000 }],
      logout: ['/api/logout', {}],
    };
    const route = routes[action]; if (!route) throw Error('不支持此音乐操作。');
    return { url: `https://music.163.com${route[0].replace('/api/', '/weapi/')}?csrf_token=${encodeURIComponent(cookie.__csrf || '')}`, body: weapi({ ...route[1], csrf_token: cookie.__csrf || '' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/', 'User-Agent': ua } };
  }
  const guid = cookie.guid || '1000000001'; const uin = cookie.uin || cookie.qqmusic_uin || '0'; const key = cookie.qm_keyst || cookie.qqmusic_key || '';
  const routes = {
    search: ['music.search.SearchCgiService', 'DoSearchForQQMusicMobile', { query, search_type: 0, num_per_page: 20, page_num: page, search_id: String(Date.now()), highlight: 0 }],
    'login-create': ['music.login.LoginServer', 'CreateQRCode', { tmeAppID: 'qqmusic' }],
    'login-check': ['music.login.LoginServer', 'CheckQRCode', { qrcodeID: data.key, tmeAppID: 'qqmusic' }],
    session: ['music.UserInfo.userInfoServer', 'GetLoginUserInfo', {}],
    detail: ['music.pf_song_detail_svr', 'get_song_detail_yqq', { song_mid: id }],
    playback: ['vkey.GetVkeyServer', 'CgiGetVkey', { guid, songmid: [id], songtype: [0], uin, loginflag: key ? 1 : 0, platform: '20' }],
    download: ['vkey.GetVkeyServer', 'CgiGetVkey', { guid, songmid: [id], songtype: [0], uin, loginflag: key ? 1 : 0, platform: '20' }],
  };
  const route = routes[action]; if (!route) throw Error('不支持此音乐操作。');
  const mobile = ['login-create', 'login-check', 'session'].includes(action);
  const comm = mobile ? { ct: 11, cv: 20090008, v: 20090008, tmeAppID: 'qqmusic', guid, qq: uin, authst: key } : { ct: 19, cv: 2201, guid, uin: Number(uin) || 0, authst: key };
  return { url: 'https://u.y.qq.com/cgi-bin/musicu.fcg', body: JSON.stringify({ comm, req_0: { module: route[0], method: route[1], param: route[2] } }), headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com', 'User-Agent': mobile ? 'QQMusic 20090008(android 14)' : ua } };
}
function captureLogin(cookie, value) {
  const source = value?.req_0?.data || {};
  if (source.musickey && (source.musicid || source.uin)) {
    cookie.qm_keyst = cookie.qqmusic_key = String(source.musickey);
    cookie.uin = cookie.qqmusic_uin = String(source.musicid || source.uin);
    for (const key of ['refresh_token', 'refresh_key', 'openid', 'access_token']) if (source[key]) cookie[key] = String(source[key]);
  }
}
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(musickey|qm_keyst|qqmusic_key|refresh_token|refresh_key|access_token|login_key|cookie|cookieStr)$/i.test(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}
function mediaUrl(provider, value) {
  const url = new URL(value); const suffixes = provider === 'qq' ? ['qqmusic.qq.com', 'music.qq.com', 'aqqmusic.tc.qq.com'] : provider === 'netease' ? ['music.126.net', 'music.163.com'] : [];
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) throw Error('音频地址不属于当前音乐平台。');
  return url.href;
}
module.exports = function createProviders({ directory, safeStorage, fetch }) {
  const controllers = new Map(); const revisions = { qq: 0, netease: 0 }; const queues = {};
  const downloads = new Map(); const progress = new Map();
  const file = (provider) => path.join(directory, 'config', `provider-${provider}.bin`);
  const read = async (provider) => { try { return JSON.parse(safeStorage.decryptString(await fs.readFile(file(provider)))); } catch (error) { if (error.code === 'ENOENT') return {}; throw Error('本机音乐账号凭据无法解密，请退出账号后重新登录。'); } };
  const save = async (provider, cookie) => {
    if (!safeStorage.isEncryptionAvailable()) throw Error('系统加密存储不可用，无法保存音乐账号。');
    await fs.mkdir(path.dirname(file(provider)), { recursive: true });
    const temporary = `${file(provider)}.tmp`; await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(cookie))); await fs.rename(temporary, file(provider));
  };
  const serial = (provider, fn) => { const next = (queues[provider] || Promise.resolve()).catch(() => {}).then(fn); queues[provider] = next; return next; };
  return {
    cancel(id) { controllers.get(id)?.abort(); },
    downloadState(id) { return progress.get(id) || { bytes: 0, total: 0 }; },
    async download({ id, provider, url }) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || controllers.has(id) || downloads.has(id)) throw Error('下载标识无效或已在下载。');
      let target = mediaUrl(provider, url); const controller = new AbortController(); controllers.set(id, controller); progress.set(id, { bytes: 0, total: 0 });
      const filename = path.join(directory, 'Temp', 'provider-downloads', `${id}.audio`); let handle; let created = false;
      try {
        let response;
        for (let redirect = 0; redirect <= 3; redirect++) { response = await fetch(target, { headers: { 'Accept-Encoding': 'identity' }, credentials: 'omit', redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) }); if (![301, 302, 303, 307, 308].includes(response.status)) break; const next = response.headers.get('location'); await response.body?.cancel(); if (!next || redirect === 3) throw Error('音频下载重定向异常。'); target = mediaUrl(provider, new URL(next, target).href); }
        if (!response.ok || !response.body) throw Error(`音频下载失败（HTTP ${response.status}）。`);
        const total = Number(response.headers.get('content-length')) || 0; if (total > 200 * 1024 * 1024) throw Error('单首音频超过 200 MB。');
        await fs.mkdir(path.dirname(filename), { recursive: true }); handle = await fs.open(filename, 'wx'); created = true; let bytes = 0;
        for await (const chunk of response.body) { controller.signal.throwIfAborted(); if (bytes + chunk.length > 200 * 1024 * 1024) throw Error('单首音频超过 200 MB。'); let offset = 0; while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset, bytes + offset); if (!result.bytesWritten) throw Error('磁盘写入未完成。'); offset += result.bytesWritten; } bytes += chunk.length; progress.set(id, { bytes, total }); }
        controller.signal.throwIfAborted(); if (!bytes || (total && bytes !== total)) throw Error('音频下载不完整，未加入音乐库。');
        const item = { filename, size: bytes, type: response.headers.get('content-type') || 'application/octet-stream' }; downloads.set(id, item); return { token: id, size: bytes, type: item.type };
      } catch (error) { await handle?.close(); handle = undefined; if (created) await fs.rm(filename, { force: true }); progress.delete(id); throw error; }
      finally { await handle?.close(); controllers.delete(id); }
    },
    async readDownload(token, offset, length) {
      const item = downloads.get(token); if (!item || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > 1024 * 1024 || offset + length > item.size) throw Error('下载读取范围无效。');
      const handle = await fs.open(item.filename, 'r'); try { const bytes = Buffer.alloc(length); const result = await handle.read(bytes, 0, length, offset); if (result.bytesRead !== length) throw Error('下载文件不完整。'); return bytes; } finally { await handle.close(); }
    },
    async removeDownload(token) { const item = downloads.get(token); if (item) { downloads.delete(token); progress.delete(token); await fs.rm(item.filename, { force: true }); } },
    async request(request) {
      if (!request || !['qq', 'netease'].includes(request.provider) || typeof request.id !== 'string' || !request.id || request.id.length > 100 || controllers.has(request.id)) throw Error('音源请求无效。');
      const { provider, action } = request;
      if (action === 'logout') {
        revisions[provider]++;
        await serial(provider, () => fs.rm(file(provider), { force: true }));
        return { code: 200 };
      }
      const revision = revisions[provider]; const cookie = await read(provider);
      const built = buildRequest(request, cookie); const controller = new AbortController(); controllers.set(request.id, controller);
      try {
        const response = await fetch(built.url, { method: 'POST', headers: { ...built.headers, Cookie: Object.entries(cookie).map(([key, value]) => `${key}=${value}`).join('; ') }, body: built.body, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        if (!response.ok) throw Error(`音乐平台响应失败（HTTP ${response.status}）。`);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) { controller.abort(); throw Error('音乐平台响应过大。'); } chunks.push(Buffer.from(chunk)); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('音乐平台返回了无效数据。'); }
        const changed = {};
        for (const header of response.headers.getSetCookie?.() || []) { const pair = header.split(';', 1)[0]; const at = pair.indexOf('='); if (at > 0 && /^[\w-]+$/.test(pair.slice(0, at))) changed[pair.slice(0, at)] = pair.slice(at + 1); }
        if (provider === 'qq' && action === 'login-check') captureLogin(changed, body);
        if (Object.keys(changed).length && revision === revisions[provider]) await serial(provider, async () => { if (revision === revisions[provider]) await save(provider, { ...await read(provider), ...changed }); });
        if (revision !== revisions[provider]) throw Error('账号已退出，请重新操作。');
        return redact(body);
      } finally { controllers.delete(request.id); }
    },
  };
};
module.exports.buildRequest = buildRequest;
module.exports.weapi = weapi;
module.exports.captureLogin = captureLogin;
module.exports.redact = redact;
module.exports.mediaUrl = mediaUrl;
