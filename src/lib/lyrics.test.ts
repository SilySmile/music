import { describe, expect, it } from 'vitest';
import { activeLyricIndex, decodeText, mergeTranslation, parseLyrics } from './lyrics';

describe('LRC parsing and translation', () => {
  it('reads multiple timestamps, fractions, metadata and signed offsets', () => {
    const lines = parseLyrics('[ar:Artist]\n[offset:-500]\n[00:02.50][01:02.500]Same line\n[00:04.5]Next line');
    expect(lines).toEqual([{ time: 2, text: 'Same line' }, { time: 4, text: 'Next line' }, { time: 62, text: 'Same line' }]);
  });
  it('merges repeated timestamps into bilingual lines', () => {
    expect(parseLyrics('[00:01]Hello\n[00:01]你好\n[00:03]World')).toEqual([{ time: 1, text: 'Hello', translation: '你好' }, { time: 3, text: 'World' }]);
  });
  it('matches translated LRC by time instead of shifting missing lines', () => {
    const original = parseLyrics('[00:01]One\n[00:03]Two\n[00:05]Three');
    const translation = parseLyrics('[00:01.10]一\n[00:05.20]三');
    const merged = mergeTranslation(original, translation);
    expect(merged.map((line) => line.translation)).toEqual(['一', undefined, '三']);
    expect(original[0].translation).toBeUndefined();
  });
  it('keeps TXT readable and aligns untimed translation by row', () => {
    const lines = parseLyrics('First\n\nSecond');
    expect(lines.map((line) => line.time)).toEqual([-1, -1]);
    expect(mergeTranslation(lines, parseLyrics('第一\n第二')).map((line) => line.translation)).toEqual(['第一', '第二']);
    expect(activeLyricIndex(lines, 99)).toBe(-1);
  });
  it('has no active line before the first timestamp and selects the latest line', () => {
    const lines = parseLyrics('[00:02]First\n[00:05]Second');
    expect(activeLyricIndex(lines, 0)).toBe(-1);
    expect(activeLyricIndex(lines, 2)).toBe(0);
    expect(activeLyricIndex(lines, 100)).toBe(1);
  });
  it('decodes UTF-8, GBK and UTF-16 Chinese lyrics', () => {
    expect(decodeText(new TextEncoder().encode('中文歌词').buffer)).toBe('中文歌词');
    expect(decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer)).toBe('中文');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]).buffer)).toBe('中文');
  });
});
