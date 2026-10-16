const crypto = require('node:crypto');

function baseUrl(value) {
  if (typeof value !== 'string' || value.trim().length > 2048) throw new Error('更新地址无效');
  const input = value.trim();
  if (!input || /[\s\\]/.test(input)) throw new Error('请输入域名或完整 HTTPS 更新地址');
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('更新地址必须为不含密码、参数和片段的 HTTPS 地址');
  if (url.pathname === '/') url.pathname = '/music-updates/';
  else if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) throw new Error('版本号必须为 主版本.次版本.修订号');
  return value.split('.').map(Number);
}
function compareVersions(first, second) {
  const left = versionParts(first); const right = versionParts(second);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  return 0;
}

function verifyEnvelope(text, publicKey, now = Date.now()) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw new Error('更新清单过大或格式无效');
  const envelope = JSON.parse(text);
  if (envelope.algorithm !== 'RSA-SHA256' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)) throw new Error('更新清单签名格式无效');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!crypto.verify('sha256', bytes, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('更新清单签名校验失败，拒绝下载或安装');
  const payload = JSON.parse(bytes.toString('utf8'));
  versionParts(payload.version);
  const issued = Date.parse(payload.issuedAt); const expires = Date.parse(payload.expiresAt);
  if (payload.product !== 'xianqiji' || payload.schema !== 1 || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 24 * 3600000 || expires <= now || expires <= issued || expires - issued > 366 * 86400000) throw new Error('更新清单不适用、已过期或设备时间不正确');
  if (typeof payload.notes !== 'string' || payload.notes.length > 12000 || !payload.artifacts || typeof payload.artifacts !== 'object') throw new Error('更新清单内容无效');
  for (const [platform, artifact] of Object.entries(payload.artifacts)) {
    const kind = { 'win-x64': 'nsis', 'win-x64-portable': 'portable', android: 'apk' }[platform];
    const extension = platform === 'android' ? 'apk' : 'exe';
    if (!kind || !artifact || artifact.kind !== kind || typeof artifact.file !== 'string' || !new RegExp(`^releases/v${payload.version.replaceAll('.', '\\.')}\/[A-Za-z0-9._-]+\\.${extension}$`).test(artifact.file) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 4 * 1024 * 1024 * 1024) throw new Error('安装包路径、类型、大小或校验信息无效');
  }
  return payload;
}

function artifactUrl(base, artifact) {
  const root = new URL(baseUrl(base)); const result = new URL(artifact.file, root);
  if (result.protocol !== 'https:' || result.origin !== root.origin || !result.pathname.startsWith(root.pathname)) throw new Error('安装包地址超出更新服务器范围');
  return result.href;
}

module.exports = { baseUrl, compareVersions, verifyEnvelope, artifactUrl };
