const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');

module.exports = function mediaHandler(library) {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/([a-z0-9_-]{1,128})\/audio$/i);
      if (url.hostname !== 'library' || !match || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
      const media = await library.media(match[1]);
      let start = 0; let end = media.size - 1;
      const range = request.headers.get('range');
      const headers = { 'content-type': media.type || 'application/octet-stream', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
      if (range) {
        const parts = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!parts || (!parts[1] && !parts[2])) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${media.size}` } });
        if (parts[1]) { start = Number(parts[1]); if (parts[2]) end = Math.min(end, Number(parts[2])); }
        else start = Math.max(0, media.size - Number(parts[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= media.size) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${media.size}` } });
        headers['content-range'] = `bytes ${start}-${end}/${media.size}`;
      }
      headers['content-length'] = String(Math.max(0, end - start + 1));
      const body = request.method === 'HEAD' || media.size === 0 ? null : Readable.toWeb(createReadStream(media.path, { start, end }));
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch { return new Response('Music file unavailable', { status: 404 }); }
  };
};
