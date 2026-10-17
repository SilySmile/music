import { describe, expect, it } from 'vitest';
import { applyLineTimeDraft, changeSingingEnd, createLineTimeDraft, prepareLyricRegeneration, timingFingerprint } from './lyricTimingEditor';
import { textAlignmentTargets } from './textAlignment';
import { parseLyrics } from './lyrics';
import { serializeLyrics } from './exporter';
const track = { duration: 12, lyrics: [{ time: 1, text: '你，好啊', translation: 'Hello' }, { time: 7, text: '再见' }] };
describe('manual lyric timing drafts', () => {
  it('recalculates ready lyrics and wrong saved sung ends without changing source lyrics or Chinese', () => {
    const saved = { ...track, lyrics: track.lyrics.map((line) => ({ ...line, endTime: line.time + 1, words: [{ text: line.text, time: line.time, endTime: line.time + 1 }], wordTiming: 'estimated' as const, timingNote: '旧估算' })) };
    const before = timingFingerprint(saved.lyrics);
    const lyrics = prepareLyricRegeneration(saved);
    expect(textAlignmentTargets({ ...saved, lyrics }).map(({ id, end }) => [id, end])).toEqual([[0, 7], [1, 12]]);
    expect(lyrics[0]).toMatchObject({ time: 1, text: '你，好啊', translation: 'Hello' });
    expect(lyrics.every((line) => !line.words && line.endTime === undefined && !line.wordTiming && !line.timingNote)).toBe(true);
    expect(timingFingerprint(saved.lyrics)).toBe(before);
    expect(prepareLyricRegeneration(saved, {}, [0])[1]).toBe(saved.lyrics[1]);
  });
  it('uses only newly edited phrase bounds during regeneration and bypasses corrupt old word times', () => {
    const saved = { ...track, lyrics: [{ ...track.lyrics[0], endTime: 20, words: [{ text: track.lyrics[0].text, time: 1, endTime: 20 }] }, track.lyrics[1]] };
    expect(prepareLyricRegeneration(saved)[0].endTime).toBeUndefined();
    const draft = createLineTimeDraft(saved, 0); draft.start = '2'; draft.end = '4';
    const lyrics = prepareLyricRegeneration(saved, { 0: draft });
    expect(lyrics[0]).toMatchObject({ time: 2, endTime: 4, words: undefined });
    expect(textAlignmentTargets({ ...saved, lyrics })[0]).toMatchObject({ start: 2, end: 4, nextStart: 7 });
    expect(() => prepareLyricRegeneration(saved, { 0: { ...draft, end: '8' } })).toThrow('唱完时间');
    expect(() => prepareLyricRegeneration(saved, { 0: { ...draft, start: '' } })).toThrow('开始时间');
  });
  it('keeps a three-second instrumental gap and compresses only overflowing draft words', () => {
    const initial = createLineTimeDraft(track, 0);
    const draft = changeSingingEnd(initial, '4.000');
    const line = applyLineTimeDraft(track, 0, draft);
    expect(line.endTime).toBe(4);
    expect(line.words!.at(-1)!.endTime).toBe(4);
    expect(createLineTimeDraft({ ...track, lyrics: [line, track.lyrics[1]] }, 0).end).toBe('4.000');
    expect(parseLyrics(serializeLyrics([line]))[0]).toEqual({ ...line, translation: undefined });
    expect(changeSingingEnd(draft, '5.000').words).toEqual(draft.words);
    expect(() => applyLineTimeDraft(track, 0, { ...draft, end: '8' })).toThrow('唱完时间');
    expect(() => applyLineTimeDraft(track, 0, { ...initial, end: '4' })).toThrow('第');
    expect(timingFingerprint([line])).not.toBe(timingFingerprint([{ ...line, endTime: 5 }]));
  });
  it('prepares editable character times without changing the source and persists only an explicit application', () => {
    const draft = createLineTimeDraft(track, 0);
    expect(draft.words.map((word) => word.text)).toEqual(['你，', '好', '啊']);
    expect(track.lyrics[0]).not.toHaveProperty('words');
    draft.words[0].end = '2.000'; draft.words[1].start = '2.500';
    const line = applyLineTimeDraft(track, 0, draft);
    expect(line.translation).toBe('Hello'); expect(line.words![1].time).toBe(2.5);
    expect(parseLyrics(serializeLyrics([line]))[0].words).toEqual(line.words);
  });
  it('splits multi-character timed groups for per-character editing while retaining pauses and holds', () => {
    const grouped = { duration: 10, lyrics: [{ time: 1, text: '你好啊', words: [{ text: '你好', time: 1, endTime: 3 }, { text: '啊', time: 5, endTime: 9 }] }] };
    expect(createLineTimeDraft(grouped, 0).words).toEqual([{ text: '你', start: '1.000', end: '2.000' }, { text: '好', start: '2.000', end: '3.000' }, { text: '啊', start: '5.000', end: '9.000' }]);
  });
  it('rejects missing values, overlaps, backward times, wrong text and boundary overflow', () => {
    for (const value of ['', '-1', '8', 'NaN']) {
      const draft = createLineTimeDraft(track, 0); draft.words[0].start = value;
      expect(() => applyLineTimeDraft(track, 0, draft)).toThrow();
    }
    const draft = createLineTimeDraft(track, 0); draft.words[1].start = '1.2';
    expect(() => applyLineTimeDraft(track, 0, draft)).toThrow('不重叠');
    draft.words.reverse(); expect(() => applyLineTimeDraft(track, 0, draft)).toThrow('原文');
  });
  it('can anchor a formerly untimed line and ignores unrelated Chinese changes in its conflict fingerprint', () => {
    const plain = { duration: 6, lyrics: [{ time: -1, text: '你好' }] };
    expect(applyLineTimeDraft(plain, 0, createLineTimeDraft(plain, 0)).time).toBe(0);
    expect(timingFingerprint(track.lyrics)).toBe(timingFingerprint(track.lyrics.map((line) => ({ ...line, translation: '新译文' }))));
    expect(timingFingerprint(track.lyrics)).not.toBe(timingFingerprint(track.lyrics.map((line) => ({ ...line, time: line.time + 1 }))));
  });
});
