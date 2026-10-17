import type { LyricLine, LyricWord, Track } from '../types';
import { singingUnits } from './textAlignment';
import { timedWords } from './lyricTiming';

export type WordTimeDraft = { text: string; start: string; end: string };
export type LineTimeDraft = { start: string; words: WordTimeDraft[] };
export const timingFingerprint = (lyrics: LyricLine[]) => JSON.stringify(lyrics.map(({ time, text, words, wordTiming, timingNote }) => ({ time, text, words, wordTiming, timingNote })));
export function lineTimeEnd(track: Pick<Track, 'lyrics' | 'duration'>, index: number) {
  return track.lyrics.slice(index + 1).find((line) => line.time >= 0)?.time ?? track.duration;
}
export function createLineTimeDraft(track: Pick<Track, 'lyrics' | 'duration'>, index: number): LineTimeDraft {
  const line = track.lyrics[index];
  if (!line) return { start: '0', words: [] };
  const start = Math.max(0, line.time), end = lineTimeEnd(track, index);
  const existing = timedWords(line);
  const source = existing || [{ time: start, endTime: end, text: line.text }];
  const words = source.flatMap((word, wordIndex) => {
    const units = singingUnits(word.text);
    const finish = word.endTime ?? source[wordIndex + 1]?.time ?? end;
    return units.map((text, index) => ({ text, start: (word.time + (finish - word.time) * index / units.length).toFixed(3), end: (word.time + (finish - word.time) * (index + 1) / units.length).toFixed(3) }));
  });
  return { start: start.toFixed(3), words };
}
export function applyLineTimeDraft(track: Pick<Track, 'lyrics' | 'duration'>, index: number, draft: LineTimeDraft): LyricLine {
  const line = track.lyrics[index];
  const start = draft.start.trim() ? Number(draft.start) : NaN;
  const previous = track.lyrics.slice(0, index).filter((line) => line.time >= 0).at(-1)?.time ?? 0;
  const end = lineTimeEnd(track, index);
  if (!line || !Number.isFinite(start) || start < previous || !Number.isFinite(end) || start >= end) throw new Error('本句开始时间应在上一句开始与下一句开始之间。');
  if (!draft.words.length || draft.words.map((word) => word.text).join('') !== line.text) throw new Error('逐字草稿与原文不一致，请还原草稿后重新调整。');
  let previousEnd = start;
  const words: LyricWord[] = draft.words.map((word, wordIndex) => {
    const time = word.start.trim() ? Number(word.start) : NaN, endTime = word.end.trim() ? Number(word.end) : NaN;
    if (!Number.isFinite(time) || !Number.isFinite(endTime) || time < previousEnd || endTime <= time || endTime > end) throw new Error(`第 ${wordIndex + 1} 个字词时间无效：需按顺序、不重叠，并在 ${start.toFixed(3)}–${end.toFixed(3)} 秒内。`);
    previousEnd = endTime;
    return { text: word.text, time, endTime };
  });
  const result = { ...line, time: start, words };
  if (!timedWords(result)) throw new Error('逐字时间无效，原歌词保留。');
  return result;
}
