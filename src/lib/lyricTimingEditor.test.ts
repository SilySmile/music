import { describe, expect, it } from 'vitest';
import { applyLineTimeDraft, createLineTimeDraft, timingFingerprint } from './lyricTimingEditor';
import { parseLyrics } from './lyrics';
import { serializeLyrics } from './exporter';
const track = { duration: 12, lyrics: [{ time: 1, text: '你，好啊', translation: 'Hello' }, { time: 7, text: '再见' }] };
describe('manual lyric timing drafts', () => {
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
