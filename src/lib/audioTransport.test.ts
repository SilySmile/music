import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const createRequests = createRequire(import.meta.url)('../../electron/audio-alignment.cjs');
const config = { key: 'local-fake-secret' };
describe('native multipart audio transport', () => {
  const request = { id: 'test-request', url: 'https://audio.example.test/v1/audio/transcriptions', key: config.key, model: 'whisper-1', filename: 'song.mp3', type: 'audio/mpeg', bytes: new Uint8Array([1, 2, 3]) };
  it('sends a real audio file, word granularity and a separate model without adding the key to the URL', async () => {
    const fetch = vi.fn(async (_url, options) => { expect(options.body.get('file').size).toBe(3); expect(options.body.get('response_format')).toBe('verbose_json'); expect(options.body.get('timestamp_granularities[]')).toBe('word'); expect(options.body.get('model')).toBe('whisper-1'); return new Response(JSON.stringify({ words: [] }), { status: 200 }); });
    await createRequests({ fetch }).request(request); expect(fetch.mock.calls[0][0]).not.toContain(config.key);
  });
  it('rejects malformed requests before network access and never auto retries', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 404 })); const native = createRequests({ fetch });
    for (const value of [{ ...request, url: 'http://audio.example.test/audio/transcriptions' }, { ...request, bytes: new Uint8Array() }, { ...request, filename: 'secret.txt' }]) await expect(native.request(value)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); await expect(native.request(request)).rejects.toThrow('404'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborts an in-flight native request instead of only hiding progress', async () => {
    const native = createRequests({ fetch: async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
    const result = native.request(request); native.cancel(request.id); await expect(result).rejects.toThrow('aborted');
  });
});
