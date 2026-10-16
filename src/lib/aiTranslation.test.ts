import { describe, expect, it, vi } from 'vitest';
import { defaultAIConfig, readAITranslations, translateWithAI, translationPassage } from './aiTranslation';
import type { AIRequest } from '../types';

const config = { ...defaultAIConfig, key: 'test-not-a-real-key' };
const song = { title: 'Quiet Room', artist: 'Demo Artist', album: 'Season' };
const lines = [{ time: 1, text: 'Soft light' }, { time: 5, text: 'A quiet room' }, { time: 8, text: 'Soft   light' }, { time: 11, text: 'Already translated', translation: '已有中文' }];

function reply(request: AIRequest) {
  const messages = request.body.messages as { content: string }[];
  const input = JSON.parse(messages[1].content);
  return { choices: [{ message: { content: JSON.stringify({ song: input.song, translations: input.lines.map((item: { id: number; source: string }) => ({ ...item, text: '中文' + item.id })) }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 60 } };
}

describe('song-aware reviewed AI translations', () => {
  it('deduplicates, translates and reviews with song identity and no user output limits', async () => {
    const request = vi.fn(async (input: AIRequest) => reply(input));
    const result = await translateWithAI(lines, config, 'en', { request, song });
    expect(request).toHaveBeenCalledTimes(2);
    const payload = request.mock.calls[0][0];
    const input = JSON.parse((payload.body.messages as { content: string }[])[1].content);
    expect(input.song).toEqual(song);
    expect(input.lines).toHaveLength(2);
    expect(input.lines[0]).toEqual({ id: 0, source: 'Soft light', occurrences: [1, 3] });
    expect(input.context).toEqual({ coverage: 'complete', totalLines: 4, lines: lines.map((line, index) => ({ line: index + 1, source: line.text.replace(/\s+/g, ' ') })) });
    const review = JSON.parse((request.mock.calls[1][0].body.messages as { content: string }[])[1].content);
    expect(review.context).toEqual(input.context);
    expect(review.lines[0].occurrences).toEqual([1, 3]);
    expect(payload.body.thinking).toEqual({ type: 'disabled' });
    expect(payload.body).not.toHaveProperty('max_tokens');
    expect(result.lyrics[0].translation).toBe(result.lyrics[2].translation);
    expect(result.lyrics[3].translation).toBe('已有中文');
    expect(result.lyrics[0].time).toBe(1);
    expect(result.verifiedCount).toBe(2);
    expect(result.inputTokens + result.outputTokens).toBe(320);
  });
  it('reuses reviewed cache for this song only and excludes API keys', async () => {
    const stored = new Map<string, string>();
    const cache = { get: async (key: string) => stored.get(key), set: async (key: string, value: string) => { stored.set(key, value); } };
    const request = vi.fn(async (input: AIRequest) => reply(input));
    await translateWithAI(lines, config, 'en', { request, cache, song });
    const cached = await translateWithAI(lines, config, 'en', { request, cache, song });
    expect(request).toHaveBeenCalledTimes(2);
    expect(cached.requests).toBe(0);
    expect(cached.cacheHits).toBe(2);
    await translateWithAI(lines, config, 'en', { request, cache, song: { ...song, title: 'Another Song' } });
    expect(request).toHaveBeenCalledTimes(4);
    expect([...stored.keys()].join()).not.toContain(config.key);
  });
  it('never applies or caches an unreviewed draft when proofreading fails', async () => {
    const request = vi.fn().mockImplementationOnce(async (input: AIRequest) => reply(input)).mockRejectedValueOnce(new Error('Review unavailable'));
    const set = vi.fn();
    const result = await translateWithAI(lines, config, 'en', { request, song, cache: { get: async () => undefined, set } });
    expect(result.translatedCount).toBe(0);
    expect(result.error).toBe('Review unavailable');
    expect(request).toHaveBeenCalledTimes(2);
    expect(set).not.toHaveBeenCalled();
  });
  it('preserves reviewed batches when a later batch fails without automatic retries', async () => {
    const request = vi.fn().mockImplementationOnce(async (input: AIRequest) => reply(input)).mockImplementationOnce(async (input: AIRequest) => reply(input)).mockRejectedValueOnce(new Error('Network unavailable'));
    const result = await translateWithAI([{ time: 1, text: 'A'.repeat(3000) }, { time: 2, text: 'B'.repeat(3000) }], config, 'en', { request, song });
    expect(result.translatedCount).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.error).toBe('Network unavailable');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('rejects incorrect song, tampered source, duplicate and missing IDs', () => {
    const encode = (translations: unknown, identity = song) => JSON.stringify({ song: identity, translations });
    expect(() => readAITranslations(encode([{ id: 0, source: 'Other', text: '中文' }]), [0], ['Soft light'], song)).toThrow('原文');
    expect(() => readAITranslations(encode([{ id: 0, source: 'Soft light', text: '中文' }], { ...song, title: 'Wrong song' }), [0], ['Soft light'], song)).toThrow('歌曲');
    expect(() => readAITranslations(encode([{ id: 0, source: 'Soft light', text: '中文' }], { ...song, album: 'Wrong album' }), [0], ['Soft light'], song)).toThrow('专辑');
    expect(() => readAITranslations(encode([{ id: 0, text: '一' }, { id: 0, text: '二' }]), [0, 1])).toThrow('行号');
    expect(() => readAITranslations(encode([]), [0])).toThrow('行数');
  });
  it('refuses service-truncated output and reports usage without retrying', async () => {
    const request = vi.fn().mockResolvedValue({ choices: [{ finish_reason: 'length', message: { content: '{' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
    const result = await translateWithAI(lines, config, 'en', { request, song });
    expect(result.translatedCount).toBe(0);
    expect(result.error).toContain('截断');
    expect(result.inputTokens + result.outputTokens).toBe(5);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('includes exact nearby passages beyond the old context cutoff without sending a long full song', () => {
    const longSong = Array.from({ length: 500 }, (_, index) => ({ time: index, text: `Line ${index} ${'words '.repeat(8)}` }));
    const passage = translationPassage(longSong, [longSong[450].text.trim()]);
    expect(passage.context.coverage).toBe('surrounding-passages');
    expect(passage.context.lines.map((line) => line.line)).toEqual([449, 450, 451, 452, 453]);
    expect(passage.targets[0].occurrences).toEqual([451]);
    expect(passage.context.lines[2].source).toBe(longSong[450].text.trim());
  });
  it('only explicitly requested retranslations bypass cache and replace reviewed lines', async () => {
    const original = [{ time: 2, text: 'Soft light', translation: '旧译文' }, { time: 5, text: '中文歌词' }];
    const get = vi.fn(async () => '旧缓存');
    const request = vi.fn(async (input: AIRequest) => reply(input));
    const normal = await translateWithAI(original, config, 'en', { request, song });
    expect(normal.requests).toBe(0);
    const result = await translateWithAI(original, config, 'en', { request, song, retranslate: true, cache: { get, set: vi.fn() } });
    expect(get).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.lyrics[0].translation).toBe('中文0');
    expect(result.lyrics[1].translation).toBeUndefined();
    expect(result.remaining).toBe(0);
    expect(original[0].translation).toBe('旧译文');
  });
  it('preserves existing Chinese and timestamps if retranslation proofreading fails', async () => {
    const original = [{ time: 4, text: 'Soft light', translation: '原先保存的中文' }];
    const request = vi.fn().mockImplementationOnce(async (input: AIRequest) => reply(input)).mockRejectedValueOnce(new Error('Review unavailable'));
    const result = await translateWithAI(original, config, 'en', { request, song, retranslate: true });
    expect(result.lyrics).toEqual(original);
    expect(result.remaining).toBe(1);
    expect(result.translatedCount).toBe(0);
  });
});
