import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { parseLyrics } from './lyrics';
import { enhancedLyricText, extrapolateLyricPosition, timedWords, wordProgress } from './lyricTiming';
import { serializeLyrics } from './exporter';
import TimedLyricText from '../components/TimedLyricText';
const native = createRequire(import.meta.url)('../../electron/lyric-timing.cjs');

describe('real word timing', () => {
  it('reads uneven syllables, a long hold and an explicit last-word end', () => {
    const [line] = parseLyrics('[00:01.000]<00:01.000>快<00:01.200>唱<00:01.400>啊<00:05.000>');
    expect(line.text).toBe('快唱啊');
    expect(line.words).toEqual([{ time: 1, endTime: 1.2, text: '快' }, { time: 1.2, endTime: 1.4, text: '唱' }, { time: 1.4, endTime: 5, text: '啊' }]);
    expect(wordProgress(line.words![0], 1.1)).toBeCloseTo(50);
    expect(wordProgress(line.words![2], 3.2)).toBeCloseTo(50);
    expect(wordProgress(line.words![2], 6)).toBe(100);
  });
  it('preserves explicit rests, spaces and milliseconds through enhanced LRC export', () => {
    const input = '[00:01.234]<00:01.234>Sing <00:01.567><00:03.001>now<00:04.009>';
    const [line] = parseLyrics(input);
    expect(line.text).toBe('Sing now');
    expect(line.words?.[0]).toEqual({ time: 1.234, endTime: 1.567, text: 'Sing ' });
    expect(wordProgress(line.words![0], 2)).toBe(100);
    expect(wordProgress(line.words![1], 2)).toBe(0);
    expect(parseLyrics(serializeLyrics([line]))).toEqual([line]);
    expect(native.enhancedText(line)).toBe(enhancedLyricText(line));
  });
  it('reads YRC durations and holds the highlight still in a gap', () => {
    const [line] = parseLyrics('[1000,5000](1000,200,0)我(2500,3500,0)们');
    expect(line).toEqual({ time: 1, text: '我们', words: [{ time: 1, endTime: 1.2, text: '我' }, { time: 2.5, endTime: 6, text: '们' }] });
    expect(wordProgress(line.words![0], 2)).toBe(100);
    expect(wordProgress(line.words![1], 2)).toBe(0);
    expect(parseLyrics(serializeLyrics([line]))).toEqual([line]);
  });
  it('keeps offset and repeated line timestamps aligned with their words', () => {
    const lines = parseLyrics('[offset:-500]\n[00:02.000][01:02.000]<00:02.000>Hi<00:03.000>');
    expect(lines.map((line) => line.time)).toEqual([1.5, 61.5]);
    expect(lines[0].words?.[0]).toEqual({ time: 1.5, endTime: 2.5, text: 'Hi' });
    expect(lines[1].words?.[0]).toEqual({ time: 61.5, endTime: 62.5, text: 'Hi' });
  });
  it('does not invent durations for ordinary LRC or the final unbounded word', () => {
    const [plain] = parseLyrics('[00:01.00]Plain line');
    expect(timedWords(plain)).toBeUndefined();
    expect(native.timedWords(plain)).toBeUndefined();
    const [enhanced] = parseLyrics('[00:01]<00:01>Hello <00:02>world');
    expect(wordProgress(enhanced.words![1], 1.9)).toBe(0);
    expect(wordProgress(enhanced.words![1], 2)).toBe(100);
    const markup = renderToStaticMarkup(createElement(TimedLyricText, { text: plain.text, position: 1.1, active: true }));
    expect(markup).toContain('data-timing="line"');
    expect(markup).not.toContain('clip-path');
  });
  it('rejects corrupt or mismatched word data without rendering timing markers', () => {
    expect(parseLyrics('[00:01]<00:03>Hi<00:02>there')[0]).toEqual({ time: 1, text: 'Hithere' });
    const invalid = [
      { time: 1, text: 'A', words: [{ time: NaN, text: 'A' }] },
      { time: 1, text: 'A', words: [{ time: 1, endTime: .5, text: 'A' }] },
      { time: 1, text: 'A', words: [{ time: 1, text: 'B' }] },
    ];
    for (const value of invalid) { expect(timedWords(value)).toBeUndefined(); expect(native.timedWords(value)).toBeUndefined(); }
  });
  it('clips each word independently across horizontal and vertical layouts', () => {
    const [line] = parseLyrics('[00:01]<00:01>我<00:02>们<00:04>');
    const horizontal = renderToStaticMarkup(createElement(TimedLyricText, { ...line, active: true, position: 1.5 }));
    const vertical = renderToStaticMarkup(createElement(TimedLyricText, { ...line, active: true, position: 1.5, vertical: true }));
    expect(horizontal).toContain('inset(0 50% 0 0)');
    expect(horizontal).toContain('inset(0 100% 0 0)');
    expect(vertical).toContain('inset(0 0 50% 0)');
    expect(vertical).toContain('inset(0 0 100% 0)');
  });
  it('freezes when paused or buffering, bounds stale samples and honors playback rate', () => {
    expect(extrapolateLyricPosition(2, 50, true)).toBe(2.05);
    expect(extrapolateLyricPosition(2, 5000, true)).toBe(2.1);
    expect(extrapolateLyricPosition(2, 50, false)).toBe(2);
    expect(extrapolateLyricPosition(2, 50, true, 2)).toBe(2.1);
    expect(extrapolateLyricPosition(2, -50, true)).toBe(2);
  });
});
