import { describe, expect, it, vi } from 'vitest';
import type { AIConfig, AIRequest, Track } from '../types';
import { generateTextAlignment, readEstimatedTimings, singingUnits, textAlignmentTargets } from './textAlignment';
import { parseLyrics } from './lyrics';
import { serializeLyrics } from './exporter';
import { alignmentSignature } from './audioAlignment';

const track: Track = { id: 'fixture-audio', title: '歌', artist: '歌手', album: '录音室版', duration: 12, format: 'mp3', audio: new Blob(['never-upload']), lyrics: [{ time: 1, text: '你，好啊', translation: 'Hello' }, { time: 7, text: 'Stay here!', translation: '留在这里' }], favorite: false, addedAt: 1 };
const song = { title: track.title, artist: track.artist, album: track.album };
const config: AIConfig = { url: 'https://api.deepseek.com', model: 'deepseek-flash', key: 'fake-local-key', singingHint: '逗号换气，句尾拖音' };
const answer = (targets = textAlignmentTargets(track)) => ({ song, lines: targets.map((target) => ({ id: target.id, source: target.source, singing: '可能在逗号处换气、末字拖音，未经录音验证', words: target.units.map((text, index) => ({ text, start: target.start + index * .5, end: target.start + index * .5 + .3 })) })) });

describe('chat-based singing time estimates', () => {
  it('keeps every character and punctuation, splitting CJK characters and Western words', () => {
    expect(singingUnits('“你，好啊！ Stay here.”')).toEqual(['“你，', '好', '啊！ ', 'Stay ', 'here.”']);
    expect(singingUnits('Hi你好love你')).toEqual(['Hi', '你', '好', 'love', '你']);
    expect(textAlignmentTargets(track).map(({ start, end }) => [start, end])).toEqual([[1, 7], [7, 12]]);
  });
  it('uses the existing DeepSeek chat model, song version and singing hints without touching or uploading audio', async () => {
    const read = vi.spyOn(track.audio, 'arrayBuffer');
    const request = vi.fn(async (input: AIRequest) => {
      expect(input.url).toBe('https://api.deepseek.com/chat/completions');
      expect(input.body.model).toBe('deepseek-flash');
      const messages = input.body.messages as { content: string }[];
      expect(messages[0].content).toContain('你没有听到音频');
      expect(JSON.parse(messages[1].content)).toMatchObject({ song, singingHint: config.singingHint });
      expect(JSON.stringify(input.body)).not.toContain('never-upload');
      return { choices: [{ message: { content: JSON.stringify(answer()) } }] };
    });
    const result = await generateTextAlignment(track, config, new AbortController().signal, { request });
    expect(request).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ matched: 2, unmatched: 0 });
    expect(result.lyrics[0]).toMatchObject({ time: 1, text: track.lyrics[0].text, translation: 'Hello', wordTiming: 'estimated' });
    expect(track.lyrics[0].words).toBeUndefined();
  });
  it('rejects changed source, reordered units, invalid numbers and false song versions', () => {
    const targets = textAlignmentTargets(track);
    const cases = [answer(), answer(), answer(), answer()];
    cases[0].lines[0].source = '被替换'; cases[1].lines[0].words.reverse();
    cases[2].song = { ...song, album: '另一版本' }; cases[3].lines[0].words[0].start = NaN;
    for (const value of cases) expect(() => readEstimatedTimings(JSON.stringify(value), targets, song)).toThrow();
  });
  it('maps vocal lengths and rests into the original line with no overlap, including numeric strings', () => {
    const targets = textAlignmentTargets(track);
    const weighted = { song, lines: targets.map((target) => ({ id: target.id, source: target.source, singing: '换气后连唱，末字拖音，未经录音验证', tailPause: '1', words: target.units.map((text, index) => ({ text, duration: index === target.units.length - 1 ? '4' : '1', pauseBefore: index === 1 ? '.8' : 0 })) })) };
    const result = readEstimatedTimings(JSON.stringify(weighted), targets, song);
    for (const target of targets) {
      const words = result.get(target.id)!.words!;
      expect(words.map((word) => word.text).join('')).toBe(target.source);
      expect(words[0].time).toBeGreaterThanOrEqual(target.start);
      expect(words.at(-1)!.endTime).toBeLessThan(target.end);
      for (const [index, word] of words.entries()) {
        expect(word.time).toBeGreaterThanOrEqual(words[index - 1]?.endTime ?? target.start);
        expect(word.endTime).toBeGreaterThan(word.time);
      }
      expect(words[1].time).toBeGreaterThan(words[0].endTime!);
      expect(words.at(-1)!.endTime! - words.at(-1)!.time).toBeGreaterThan((words[0].endTime! - words[0].time) * 3);
    }
  });
  it('locally repairs legacy boundary overflow, overlaps and reversed timestamps while preserving source order', () => {
    const targets = textAlignmentTargets(track);
    for (const change of [
      (value: ReturnType<typeof answer>) => { value.lines[0].words[1].start = 1.1; },
      (value: ReturnType<typeof answer>) => { value.lines[0].words.at(-1)!.end = 8; },
      (value: ReturnType<typeof answer>) => { value.lines[0].words[1].start = .5; },
    ]) {
      const value = answer(); change(value);
      const line = readEstimatedTimings(JSON.stringify(value), targets, song).get(0)!;
      expect(line.timingNote).toContain('整理到原句范围');
      expect(line.wordTiming).toBe('estimated');
      for (const [index, word] of line.words!.entries()) {
        expect(word.text).toBe(targets[0].units[index]);
        expect(word.time).toBeGreaterThanOrEqual(line.words![index - 1]?.endTime ?? targets[0].start);
        expect(word.endTime).toBeGreaterThan(word.time);
        expect(word.endTime).toBeLessThanOrEqual(targets[0].end);
      }
    }
    expect(readEstimatedTimings(JSON.stringify(answer()), targets, song).get(0)!.words![0]).toEqual({ text: '你，', time: 1, endTime: 1.3 });
  });
  it('rejects missing/negative vocal lengths, invalid rests and too-short intervals without fabricating uniform words', () => {
    const targets = textAlignmentTargets(track);
    const weighted = () => ({ song, lines: targets.map((target) => ({ id: target.id, source: target.source, singing: '估算', words: target.units.map((text) => ({ text, duration: 1, pauseBefore: 0 })) })) });
    for (const invalid of [-1, 0, NaN]) {
      const value = weighted(); value.lines[0].words[0].duration = invalid;
      expect(() => readEstimatedTimings(JSON.stringify(value), targets, song)).toThrow();
    }
    const value = weighted(); value.lines[0].words[0].pauseBefore = -1;
    expect(() => readEstimatedTimings(JSON.stringify(value), targets, song)).toThrow();
    expect(() => readEstimatedTimings(JSON.stringify(weighted()), targets.map((target) => ({ ...target, end: target.start + .001 })), song)).toThrow();
  });
  it('preserves the estimate marker through standalone enhanced LRC and leaves Chinese plain', () => {
    const estimates = readEstimatedTimings(JSON.stringify(answer()), textAlignmentTargets(track), song);
    const lines = track.lyrics.map((line, index) => ({ ...line, ...estimates.get(index) }));
    const lrc = serializeLyrics(lines);
    expect(lrc).toContain('[x-timing:estimated]');
    expect(parseLyrics(lrc).every((line) => line.wordTiming === 'estimated' && line.words?.length)).toBe(true);
    expect(serializeLyrics(lines, true)).not.toContain('estimated');
  });
  it('skips genuine word timings and unanchored plain text, and never calls after cancellation', async () => {
    const request = vi.fn();
    const ready = { ...track, lyrics: parseLyrics('[00:01]<00:01>你好<00:02>') };
    expect((await generateTextAlignment(ready, config, new AbortController().signal, { request })).existing).toBe(1);
    await generateTextAlignment({ ...track, lyrics: [{ time: -1, text: '纯文本' }] }, config, new AbortController().signal, { request });
    const controller = new AbortController(); controller.abort();
    await expect(generateTextAlignment(track, config, controller.signal, { request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('batches long lyrics and refuses truncated responses rather than saving partial guessed text', async () => {
    const many = { ...track, duration: 100, lyrics: Array.from({ length: 12 }, (_, index) => ({ time: index * 4, text: `歌${index}` })) };
    const request = vi.fn(async (input: AIRequest) => {
      const target = JSON.parse((input.body.messages as { content: string }[])[1].content).lines;
      return { choices: [{ message: { content: JSON.stringify(answer(target)) } }] };
    });
    expect((await generateTextAlignment(many, config, new AbortController().signal, { request })).matched).toBe(12);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(generateTextAlignment(track, config, new AbortController().signal, { request: async () => ({ choices: [{ finish_reason: 'length' }] }) })).rejects.toThrow('截断');
  });
  it('separates audio and text checkpoints and invalidates them when singing hints or the text model changes', () => {
    const before = alignmentSignature(track, config);
    for (const next of [{ ...config, alignmentMode: 'audio' as const }, { ...config, singingHint: '快唱' }, { ...config, model: 'another-model' }]) expect(alignmentSignature(track, next)).not.toBe(before);
  });
});
