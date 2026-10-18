import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { AudioAIRequest, Track } from '../types';
import { defaultForcedConfig, forcedTargets, forcedUrl, generateForcedAlignmentPass as generateForcedAlignment, generateForcedAlignment as generateForcedAlignmentRounds, needsForcedAlignment } from './forcedAlignment';
import { prepareLyricRegeneration, timingFingerprint } from './lyricTimingEditor';
import { serializeLyrics } from './exporter';
import { parseLyrics } from './lyrics';
const native = createRequire(import.meta.url)('../../electron/audio-alignment.cjs');
const track: Track = { id: 'fixture', title: 'Fixture', artist: '', album: '', duration: 12, format: 'wav', audio: new Blob(['audio']), favorite: false, addedAt: 1, lyrics: [{ time: 1, text: '你好', translation: 'Hello' }, { time: 7, text: '再见' }] };
const config = { ...defaultForcedConfig, key: 'fixture-only-key' };
const prepared = async () => ({ bytes: new Uint8Array([1, 2]), type: 'audio/wav', filename: 'song.wav' });
const response = () => ({ protocol: 1, model: config.model, trackId: track.id, lines: [{ id: 0, text: '你好', words: [{ text: '你', start: 1, end: 2 }, { text: '好', start: 3, end: 4 }] }, { id: 1, text: '再见', error: '未匹配' }] });
describe('local forced alignment', () => {
  it('allows only explicit loopback HTTP or HTTPS and never exposes credentials in a URL', () => {
    expect(forcedUrl(config.url)).toBe('http://127.0.0.1:8765/v1/alignments');
    expect(forcedUrl('http://localhost:8765')).toBe('http://localhost:8765/v1/alignments');
    expect(forcedUrl('https://private.example.test/v1/alignments', 'health')).toBe('https://private.example.test/v1/health');
    for (const url of ['http://192.168.1.3:8765', 'http://127.0.0.1.evil:80', 'ftp://127.0.0.1', 'https://user:secret@x.test', config.url + '?key=x']) expect(() => forcedUrl(url)).toThrow();
  });
  it('replaces old estimates without treating their wrong sung ends as hard bounds', () => {
    const estimated = { ...track, lyrics: [{ ...track.lyrics[0], endTime: 2, wordTiming: 'estimated' as const, words: [{ text: '你好', time: 1, endTime: 2 }] }] };
    expect(needsForcedAlignment(estimated)).toBe(true);
    expect(forcedTargets(estimated)[0].end).toBe(12);
    const ready = { ...estimated, lyrics: estimated.lyrics.map((line) => ({ ...line, wordTiming: undefined })) };
    expect(needsForcedAlignment(ready)).toBe(false);
    expect(forcedTargets(ready)).toEqual([]);
    expect(forcedTargets({ ...ready, lyrics: prepareLyricRegeneration(ready) })).toHaveLength(1);
  });
  it('sends audio and unchanged units, retains actual rests and leaves unmatched originals untouched', async () => {
    const before = timingFingerprint(track.lyrics);
    const request = vi.fn(async (input: AudioAIRequest) => {
      expect(input.url).toBe('http://127.0.0.1:8765/v1/alignments');
      expect(input.alignment?.lines[0]).toEqual({ id: 0, text: '你好', start: 1, end: 7, units: ['你', '好'] });
      return response();
    });
    const result = await generateForcedAlignment(track, config, new AbortController().signal, { request, prepare: prepared });
    expect(result).toMatchObject({ matched: 1, unmatched: 1 });
    expect(result.issues).toEqual([{ line: 2, reason: '未匹配' }]);
    expect(result.lyrics[0]).toMatchObject({ endTime: 4, translation: 'Hello', words: [{ text: '你', time: 1, endTime: 2 }, { text: '好', time: 3, endTime: 4 }] });
    expect(result.lyrics[1]).toBe(track.lyrics[1]);
    expect(result.lyrics[0].wordTiming).toBeUndefined();
    expect(parseLyrics(serializeLyrics(result.lyrics))[0].endTime).toBe(4);
    expect(timingFingerprint(track.lyrics)).toBe(before);
  });
  it('rejects wrong source identities and skips invalid word timings without fabricating uniform repairs', async () => {
    for (const change of [(value: ReturnType<typeof response>) => { value.trackId = 'other'; }, (value: ReturnType<typeof response>) => { value.lines[0].text = '错字'; }]) {
      const value = response(); change(value);
      await expect(generateForcedAlignment(track, config, new AbortController().signal, { request: async () => value, prepare: prepared })).rejects.toThrow();
    }
    for (const change of [(value: ReturnType<typeof response>) => { value.lines[0].words![1].start = 1.5; }, (value: ReturnType<typeof response>) => { value.lines[0].words![1].end = 8; }, (value: ReturnType<typeof response>) => { value.lines[0].words![1].text = '错'; }]) {
      const value = response(); change(value);
      expect((await generateForcedAlignment(track, config, new AbortController().signal, { request: async () => value, prepare: prepared })).matched).toBe(0);
    }
  });
  it('skips ready songs before materializing or uploading audio and honors cancellation', async () => {
    const ready = { ...track, lyrics: [{ time: 1, text: '你好', words: [{ text: '你好', time: 1, endTime: 4 }] }] };
    const prepare = vi.fn(prepared), request = vi.fn();
    await generateForcedAlignment(ready, config, new AbortController().signal, { prepare, request });
    expect(prepare).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(generateForcedAlignment(track, config, controller.signal, { prepare: async () => { controller.signal.throwIfAborted(); return prepared(); }, request })).rejects.toThrow();
  });
  it('native IPC validates local-only transport and sends reference lyrics as multipart rather than chat prompts', async () => {
    const fetch = vi.fn(async (_url, options) => {
      const alignment = JSON.parse(options.body.get('alignment'));
      expect(alignment.trackId).toBe(track.id);
      expect(options.headers.Authorization).toBe('Bearer fixture-only-key');
      return new Response(JSON.stringify(response()));
    });
    const api = native({ fetch });
    const input = { id: 'fixture-request', url: forcedUrl(config.url), key: config.key, model: config.model, ...await prepared(), alignment: { trackId: track.id, duration: track.duration, lines: forcedTargets(track) } };
    await api.request(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(api.request({ ...input, url: 'http://192.168.1.2/v1/alignments' })).rejects.toThrow();
  });
  it('native health checks also protect Windows host memory and CPU', async () => {
    const fetch = async () => new Response(JSON.stringify({ service: 'xianqiji-forced-aligner', protocol: 1, model: config.model, ready: true, resource_ready: true, concurrency: 2 }));
    const memory = native({ fetch, resources: () => ({ availableMemoryMB: 2000, cpuPercent: 20 }) });
    expect(await memory.check(config)).toMatchObject({ ready: true, resource_ready: false, reason: expect.stringContaining('内存不足') });
    const cpu = native({ fetch, resources: () => ({ availableMemoryMB: 10000, cpuPercent: 90 }) });
    expect(await cpu.check(config)).toMatchObject({ ready: true, resource_ready: false, reason: expect.stringContaining('CPU') });
  });
  it('reports live full-song progress and stops polling after completion', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: ReturnType<typeof response>) => void;
      const stage = vi.fn();
      const health = vi.fn(async () => ({ service: 'xianqiji-forced-aligner' as const, protocol: 1 as const, model: config.model, ready: true, resource_ready: true, concurrency: 2, progress: [{ trackId: track.id, total: 2, processed: 1, matched: 1 }] }));
      const pending = generateForcedAlignment(track, config, new AbortController().signal, { prepare: prepared, stage, health, request: () => new Promise((resolve) => { finish = resolve; }) });
      await vi.advanceTimersByTimeAsync(2000);
      expect(stage).toHaveBeenCalledWith(expect.stringContaining('1 / 2 句，通过 1 句'));
      finish(response()); await pending;
      await vi.advanceTimersByTimeAsync(10000);
      expect(health).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('excludes credits and full title/artist headers without excluding a sung title', () => {
    const source = { ...track, title: '你好', artist: '测试歌手', lyrics: [{ time: 0, text: '你好 - 测试歌手' }, { time: 1, text: '录音：某某' }, { time: 2, text: '混音师：某某' }, { time: 4, text: '你好' }] };
    expect(forcedTargets(source).map((line) => line.id)).toEqual([3]);
    expect(needsForcedAlignment({ ...source, lyrics: source.lyrics.slice(0, 3) })).toBe(false);
  });
  it('retries only remaining phrases with new contexts, prepares audio once and preserves sung ends', async () => {
    const prepare = vi.fn(prepared);
    const health = vi.fn(async () => ({ service: 'xianqiji-forced-aligner' as const, protocol: 1 as const, model: config.model, ready: true, resource_ready: true, concurrency: 2, alignment_strategies: 5 }));
    const calls: AudioAIRequest[] = [];
    const result = await generateForcedAlignmentRounds(track, config, new AbortController().signal, { prepare, health, request: async (input) => {
      calls.push(input);
      const manifest = input.alignment!;
      return { protocol: 1, model: config.model, trackId: track.id, lines: manifest.lines.map((line) => !manifest.attempt && line.id === 1 ? { id: line.id, text: line.text, error: '分数不足' } : { id: line.id, text: line.text, words: line.units.map((text, i) => ({ text, start: line.start + i, end: line.start + i + .5 })) }) };
    } });
    expect(calls.map((input) => [input.alignment!.attempt, input.alignment!.lines.map((line) => line.id)])).toEqual([[0, [0, 1]], [1, [1]]]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ matched: 2, unmatched: 0, rounds: 2 });
    expect(result.lyrics[0].endTime).toBe(2.5); // 4.5 seconds of interlude remain before line 2.
    expect(result.lyrics[0].translation).toBe('Hello');
    expect(parseLyrics(serializeLyrics(result.lyrics)).map(({ time, endTime, words }) => ({ time, endTime, words }))).toEqual(result.lyrics.map(({ time, endTime, words }) => ({ time, endTime, words })));
  });
  it('stops after distinct supported strategies are exhausted without claiming full success', async () => {
    const request = vi.fn(async (input: AudioAIRequest) => ({ protocol: 1, model: config.model, trackId: track.id, lines: input.alignment!.lines.map((line) => ({ id: line.id, text: line.text, error: '分数不足' })) }));
    const health = async () => ({ service: 'xianqiji-forced-aligner' as const, protocol: 1 as const, model: config.model, ready: true, resource_ready: true, concurrency: 2, alignment_strategies: 5 });
    const result = await generateForcedAlignmentRounds(track, config, new AbortController().signal, { request, prepare: prepared, health });
    expect(request).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ matched: 0, unmatched: 2, rounds: 5, lyrics: track.lyrics });
  });
  it('retains a successful phrase across four unsuccessful retries of an old estimate', async () => {
    const source = { ...track, lyrics: [{ ...track.lyrics[0], wordTiming: 'estimated' as const, words: [{ text: '你好', time: 1, endTime: 6 }] }, track.lyrics[1]] };
    const health = async () => ({ service: 'xianqiji-forced-aligner' as const, protocol: 1 as const, model: config.model, ready: true, resource_ready: true, concurrency: 2, alignment_strategies: 5 });
    const result = await generateForcedAlignmentRounds(source, config, new AbortController().signal, { prepare: prepared, health, request: async (input) => ({ protocol: 1, model: config.model, trackId: track.id, lines: input.alignment!.lines.map((line) => line.id === 0 ? { id: line.id, text: line.text, error: 'fixture unmatched' } : { id: line.id, text: line.text, words: [{ text: '再', start: 7, end: 8 }, { text: '见', start: 9, end: 10 }] }) }) });
    expect(result).toMatchObject({ matched: 1, unmatched: 1, rounds: 5 });
    expect(result.lyrics[1].words).toHaveLength(2);
    expect(result.lyrics[1].wordTiming).toBeUndefined();
  });
  it('retains partial results when resources pause, and cancels before another round', async () => {
    const request = vi.fn(async () => response());
    const controller = new AbortController();
    const health = async () => ({ service: 'xianqiji-forced-aligner' as const, protocol: 1 as const, model: config.model, ready: true, resource_ready: false, concurrency: 2 });
    const result = await generateForcedAlignmentRounds(track, config, controller.signal, { request, prepare: prepared, health });
    expect(result).toMatchObject({ matched: 1, unmatched: 1, interrupted: true });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(generateForcedAlignmentRounds(track, config, controller.signal, { request: async () => { controller.abort(); return response(); }, prepare: prepared, health })).rejects.toThrow();
  });
});
