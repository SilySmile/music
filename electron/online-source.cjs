const fs = require('node:fs/promises');
const path = require('node:path');

const defaultUrl = 'https://39.106.55.218/music-library/';
function normalize(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('在线曲库请使用不含账号、密码或参数的 HTTPS 地址。');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}
module.exports = function createOnlineSource({ directory, safeStorage, fetch }) {
  const filename = path.join(directory, 'online-source.json');
  let memory;
  return {
    async get() {
      if (memory) return { ...memory, path: filename };
      try {
        const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
        const token = saved.ciphertext ? safeStorage.decryptString(Buffer.from(saved.ciphertext, 'base64')) : '';
        return { baseUrl: normalize(saved.baseUrl), token, remember: !!saved.ciphertext, autoSync: saved.autoSync === true, path: filename };
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('在线曲库配置无法读取或解密，请重新配置。'); return { baseUrl: defaultUrl, token: '', remember: false, path: filename }; }
    },
    async save(value) {
      const baseUrl = normalize(value.baseUrl);
      if (typeof value.token !== 'string' || value.token.length > 1000 || /[\r\n]/.test(value.token)) throw new Error('无效的曲库访问密钥。');
      const token = value.token.trim();
      if (value.remember && token && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，请取消记住密钥。');
      const saved = { version: 1, baseUrl, autoSync: value.autoSync === true, encryption: 'Windows-DPAPI', ciphertext: value.remember && token ? safeStorage.encryptString(token).toString('base64') : '' };
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(`${filename}.tmp`, JSON.stringify(saved, null, 2)); await fs.rename(`${filename}.tmp`, filename);
      memory = { baseUrl, token, remember: !!value.remember, autoSync: value.autoSync === true };
      return { ...memory, path: filename };
    },
    async request(request) {
      if (!request || !['GET', 'POST'].includes(request.method) || typeof request.path !== 'string' || !/^\/(?:info|tracks(?:\/[a-f0-9]{64}(?:\/verify|\/media\/(?:audio|cover))?)?|uploads(?:\/[a-f0-9]{32}(?:\/(?:chunk|finish))?)?)(?:\?(?:offset=\d+)(?:&length=\d+)?)?$/.test(request.path)) throw new Error('无效的在线曲库请求。');
      const config = await this.get();
      if (!config.token) throw new Error('请先保存在线曲库访问密钥。');
      const body = request.method === 'POST' ? JSON.stringify(request.body || {}) : undefined;
      if (body && Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('在线曲库分块过大。');
      const response = await fetch(new URL(request.path.slice(1), config.baseUrl).href, { method: request.method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(120000), headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body });
      const reader = response.body.getReader(); const parts = []; let length = 0;
      while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('线上曲库返回内容过大。'); } parts.push(Buffer.from(next.value)); }
      let data; try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('线上服务返回的不是有效 JSON。'); }
      return { status: response.status, data };
    },
  };
};
module.exports.normalize = normalize;
