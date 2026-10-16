import { describe, expect, it, vi } from 'vitest';
import { decodeTranslation, findLyrics, readCandidates, splitTranslationText, translateMissingLyrics } from './onlineLyrics';

describe('online lyric lookup', () => {
  it('ranks artist/title/duration matches and ignores instrumental or malformed records', () => {
    const candidates = readCandidates([
      { id: 1, trackName: 'My Song', artistName: 'Other', duration: 250, plainLyrics: 'First' },
      { id: 2, trackName: 'My Song', artistName: 'Artist', duration: 181, syncedLyrics: '[00:01]Second' },
      { id: 3, trackName: 'My Song', artistName: 'Artist', duration: 180, instrumental: true },
      { id: 'bad', trackName: 'Invalid', plainLyrics: 'Ignore' },
    ], 'my song', 'Artist', 180);
    expect(candidates.map((candidate) => candidate.id)).toEqual([2, 1]);
    expect(candidates[0].synced).toBe(true);
  });
  it('keeps unknown artist out of search parameters', async () => {
    const request = vi.fn().mockResolvedValue([]);
    await findLyrics(' Song ', '未知艺术家', 0, undefined, request);
    expect(request).toHaveBeenCalledWith({ service: 'lyrics', params: { track_name: 'Song' } }, undefined);
  });
});

describe('free translation', () => {
  it('preserves timestamps and existing translations while reusing repeated lines', async () => {
    const request = vi.fn().mockResolvedValue({ responseStatus: 200, responseData: { translatedText: '微光 &amp; 清晨' } });
    const lines = [{ time: 1, text: 'Soft light' }, { time: 2, text: 'Keep me', translation: '已有译文' }, { time: 3, text: 'Soft light' }, { time: 4, text: '中文原文' }];
    const result = await translateMissingLyrics(lines, 'en', { request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.lyrics.map((line) => line.time)).toEqual([1, 2, 3, 4]);
    expect(result.lyrics.map((line) => line.translation)).toEqual(['微光 & 清晨', '已有译文', '微光 & 清晨', undefined]);
    expect(lines[0]).not.toHaveProperty('translation');
  });
  it('keeps completed work when provider quota runs out and never retries automatically', async () => {
    const request = vi.fn().mockResolvedValueOnce({ responseStatus: 200, responseData: { translatedText: '一' } }).mockResolvedValueOnce({ responseStatus: 429 });
    const result = await translateMissingLyrics([{ time: 1, text: 'One' }, { time: 2, text: 'Two' }, { time: 3, text: 'Three' }], 'en', { request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.translatedCount).toBe(1);
    expect(result.remaining).toBe(2);
    expect(result.error).toContain('额度');
  });
  it('splits long Unicode input by UTF-8 bytes without breaking characters', () => {
    const text = 'あ😀hello'.repeat(100);
    const chunks = splitTranslationText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 450)).toBe(true);
    expect(decodeTranslation('&#x4E2D;&#25991; &quot;test&quot;')).toBe('中文 "test"');
  });
});
