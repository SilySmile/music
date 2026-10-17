const uploadLimit = 24 * 1024 * 1024;
module.exports = function audioAlignmentRequests({ fetch }) {
  const active = new Map();
  return {
    cancel(id) { active.get(id)?.abort(); },
    async request(value) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value.id) || active.has(value.id)) throw new Error('无效的音频识别请求');
      const url = new URL(value.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/audio/transcriptions')) throw new Error('音频识别需要 HTTPS audio/transcriptions 接口');
      if (typeof value.key !== 'string' || !value.key.trim() || value.key.length > 1000 || /[\r\n]/.test(value.key)) throw new Error('请填写有效的 API Key');
      if (!(value.bytes instanceof Uint8Array) || !value.bytes.length || value.bytes.length > uploadLimit || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || typeof value.filename !== 'string' || !/^song\.(mp3|mp4|mpeg|mpga|m4a|wav|webm|flac|ogg)$/.test(value.filename) || typeof value.type !== 'string' || !/^audio\/[a-z0-9.+-]+$/i.test(value.type)) throw new Error('音频文件或识别模型无效，文件须小于 24 MB');
      if (value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length > 4000)) throw new Error('音频提示过长');
      if (value.language !== undefined && (typeof value.language !== 'string' || !/^[a-z]{2,3}$/.test(value.language))) throw new Error('音频语言无效');
      const form = new FormData();
      form.append('file', new Blob([value.bytes], { type: value.type }), value.filename);
      form.append('model', value.model); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
      if (value.prompt) form.append('prompt', value.prompt);
      if (value.language) form.append('language', value.language);
      const controller = new AbortController(); active.set(value.id, controller);
      try {
        const response = await fetch(url.href, { method: 'POST', headers: { Authorization: `Bearer ${value.key}` }, body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]), credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error(`音频识别失败（HTTP ${response.status}）。请确认此服务和模型支持字词时间戳并有可用余额；本轮不自动重试。`);
        return await response.json();
      } finally { active.delete(value.id); }
    },
  };
};
