import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { runAutomaticAlignment } from './automaticAlignment';
import { parseLyrics } from './lyrics';
import { alignSpeechWords, type AlignmentResult } from './audioAlignment';
import type { Track } from '../types';
const createRequests = createRequire(import.meta.url)('../../electron/audio-alignment.cjs');
const config = { url: 'https://audio.example.test/v1', model: 'text', audioModel: 'whisper-1', key: 'local-fake-secret', autoAlign: true, alignmentMode: 'audio' as const };
const song = (id: string): Track => ({ id, title: id, artist: 'Artist', album: '', format: 'mp3', duration: 20, audio: new Blob(['audio']), lyrics: [{ time: 1, text: 'Hello world', translation: '你好世界' }], favorite: false, addedAt: 1 });
function fixture() {
  const saved = new Map<string, string>();
  const cache = { get: async (key: string) => saved.get(key), set: async (key: string, value: string) => { saved.set(key, value); } };
  const generate = vi.fn(async (track: Track) => alignSpeechWords(track.lyrics, [{ word: 'Hello', start: 1, end: 2 }, { word: 'world', start: 3, end: 4 }]));
  const save = vi.fn(async (_track: Track, _result: AlignmentResult) => {}); const progress = vi.fn();
  const run = (tracks: Track[], other = {}) => runAutomaticAlignment({ tracks, config, cache, generate, save, progress, signal: new AbortController().signal, ...other });
  return { saved, generate, save, run, cache };
}
describe('automatic missing-word generation', () => {
  it('makes zero AI calls for songs with genuine word timing and preserves existing Chinese', async () => {
    const f = fixture(); const ready = { ...song('ready'), lyrics: parseLyrics('[00:01]<00:01>Hello <00:02>world<00:03>') };
    const result = await f.run([ready, song('missing')]);
    expect(result).toMatchObject({ generated: 1, skipped: 1 }); expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.save.mock.calls[0][1].lyrics[0].translation).toBe('你好世界');
  });
  it('does not repeat the same paid job after restart, including partial / unrecognized lines', async () => {
    const f = fixture(); const track = { ...song('partial'), lyrics: [...song('partial').lyrics, { time: 10, text: 'Unrecognized line' }] };
    const result = await f.run([track]); expect(result).toMatchObject({ generated: 1, partial: 1 });
    await f.run([track]); expect(f.generate).toHaveBeenCalledTimes(1);
    const aligned = f.save.mock.calls[0][1].lyrics;
    await f.run([{ ...track, lyrics: aligned }]); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.run([{ ...track, lyrics: aligned }], { retry: 'failed' }); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.run([{ ...track, lyrics: aligned }], { retry: true }); expect(f.generate).toHaveBeenCalledTimes(2);
  });
  it('stops on the first API error rather than submitting the entire library repeatedly', async () => {
    const f = fixture(); f.generate.mockRejectedValue(new Error('HTTP 404 audio unsupported'));
    expect(await f.run([song('one'), song('two')])).toMatchObject({ failed: 1, generated: 0 });
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
    await f.run([song('one'), song('two')]); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.run([song('one')], { retry: 'failed' }); expect(f.generate).toHaveBeenCalledTimes(2);
  });
  it('writes a durable pending record before upload and does not save after cancellation', async () => {
    const f = fixture(); const controller = new AbortController();
    const generate = vi.fn(async (track: Track) => { expect([...f.saved.values()].some((value) => JSON.parse(value).status === 'pending')).toBe(true); controller.abort(); return alignSpeechWords(track.lyrics, [{ word: 'Hello', start: 1, end: 2 }, { word: 'world', start: 3, end: 4 }]); });
    await f.run([song('one')], { signal: controller.signal, generate }); expect(f.save).not.toHaveBeenCalled();
    await f.run([song('one')]); expect(f.generate).not.toHaveBeenCalled();
    expect([...f.saved.values()].some((value) => JSON.parse(value).status === 'pending')).toBe(true);
  });
  it('requires a saved checkpoint before a paid call and never records an API key', async () => {
    const f = fixture();
    await f.run([song('one')], { cache: { ...f.cache, set: async () => { throw Error('disk full'); } } });
    expect(f.generate).not.toHaveBeenCalled();
    await f.run([song('one')]); expect(JSON.stringify([...f.saved])).not.toContain(config.key);
  });
  it('generates serially, skips cloud-only audio and retries when the source lyrics change', async () => {
    const f = fixture(); await f.run([song('one'), song('two'), { ...song('remote'), cloud: {} as Track['cloud'] }]);
    expect(f.generate).toHaveBeenCalledTimes(2); expect(f.save).toHaveBeenCalledTimes(2);
    await f.run([{ ...song('one'), lyrics: [{ time: 1, text: 'New source lyrics' }] }]); expect(f.generate).toHaveBeenCalledTimes(3);
  });
});

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
