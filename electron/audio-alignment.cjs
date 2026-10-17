const uploadLimit = 24 * 1024 * 1024;
const os = require('node:os');
function forcedUrl(value, endpoint = 'alignments') {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(`/${endpoint}`)) throw new Error('强对齐需要 HTTPS 或本机回环 HTTP 专用接口');
  return url;
}
module.exports = function audioAlignmentRequests({ fetch, resources }) {
  const active = new Map();
  const sample = () => os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  let previous = sample(), sampledAt = Date.now(), cpuPercent = 0;
  const hostResources = resources || (() => {
    if (Date.now() - sampledAt >= 250) {
      const next = sample(); const total = next.total - previous.total;
      cpuPercent = total > 0 ? (1 - (next.idle - previous.idle) / total) * 100 : 0;
      previous = next; sampledAt = Date.now();
    }
    return { availableMemoryMB: os.freemem() / 1048576, cpuPercent };
  });
  return {
    async check(config) {
      const url = new URL(config.url); url.pathname = url.pathname.replace(/\/(alignments|health|models)\/?$/, '').replace(/\/+$/, '') + '/health';
      if (url.pathname === '/health') url.pathname = '/v1/health';
      forcedUrl(url.href, 'health');
      if (typeof config.key !== 'string' || config.key.length > 1000 || /[\r\n]/.test(config.key)) throw new Error('无效的强对齐密钥');
      const response = await fetch(url.href, { headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(6000), redirect: 'error', credentials: 'omit' });
      if (!response.ok) throw new Error(`强对齐连接失败（HTTP ${response.status}），请检查本地服务和密钥。`);
      const result = await response.json();
      const host = hostResources();
      if (host.availableMemoryMB < 4096) return { ...result, resource_ready: false, reason: 'Windows 可用内存不足 4GB，暂停接新任务。' };
      if (host.cpuPercent > 85) return { ...result, resource_ready: false, reason: 'Windows CPU 繁忙，暂停接新任务。' };
      return result;
    },
    cancel(id) { active.get(id)?.abort(); },
    async request(value) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value.id) || active.has(value.id)) throw new Error('无效的音频识别请求');
      const url = new URL(value.url);
      if (value.alignment) forcedUrl(value.url);
      else if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/audio/transcriptions')) throw new Error('音频识别需要 HTTPS audio/transcriptions 接口');
      if (typeof value.key !== 'string' || !value.key.trim() || value.key.length > 1000 || /[\r\n]/.test(value.key)) throw new Error('请填写有效的 API Key');
      if (!(value.bytes instanceof Uint8Array) || !value.bytes.length || value.bytes.length > uploadLimit || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || typeof value.filename !== 'string' || !/^song\.(mp3|mp4|mpeg|mpga|m4a|wav|webm|flac|ogg)$/.test(value.filename) || typeof value.type !== 'string' || !/^audio\/[a-z0-9.+-]+$/i.test(value.type)) throw new Error('音频文件或识别模型无效，文件须小于 24 MB');
      if (value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length > 4000)) throw new Error('音频提示过长');
      if (value.language !== undefined && (typeof value.language !== 'string' || !/^[a-z]{2,3}$/.test(value.language))) throw new Error('音频语言无效');
      const form = new FormData();
      if (value.alignment) {
        const encoded = JSON.stringify(value.alignment);
        if (encoded.length > 200000 || !Array.isArray(value.alignment.lines) || value.alignment.lines.length > 500) throw new Error('强对齐原歌词过长');
        form.append('alignment', encoded);
      }
      form.append('file', new Blob([value.bytes], { type: value.type }), value.filename);
      form.append('model', value.model); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
      if (value.prompt) form.append('prompt', value.prompt);
      if (value.language) form.append('language', value.language);
      const controller = new AbortController(); active.set(value.id, controller);
      try {
        const response = await fetch(url.href, { method: 'POST', headers: { Authorization: `Bearer ${value.key}` }, body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(value.alignment ? 600000 : 180000)]), credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error(value.alignment ? `本地强对齐失败（HTTP ${response.status}），请检查服务、密钥和资源状态。` : `音频识别失败（HTTP ${response.status}）。请确认此服务和模型支持字词时间戳并有可用余额；本轮不自动重试。`);
        return await response.json();
      } finally { active.delete(value.id); }
    },
  };
};
