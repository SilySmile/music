import type { LyricLine, LyricWord, Track } from '../types';
import { singingUnits } from './textAlignment';
import { singingEnd, timedWords } from './lyricTiming';
import { vocalLine } from './audioAlignment';

export type WordTimeDraft = { text: string; start: string; end: string };
export type LineTimeDraft = { start: string; end: string; words: WordTimeDraft[] };
export const timingFingerprint = (lyrics: LyricLine[]) => JSON.stringify(lyrics.map(({ time, endTime, text, words, wordTiming, timingNote }) => ({ time, endTime, text, words, wordTiming, timingNote })));
export function lineTimeEnd(track: Pick<Track, 'lyrics' | 'duration'>, index: number) {
  return track.lyrics.slice(index + 1).find((line) => line.time >= 0)?.time ?? track.duration;
}
export function createLineTimeDraft(track: Pick<Track, 'lyrics' | 'duration'>, index: number): LineTimeDraft {
  const line = track.lyrics[index];
  if (!line) return { start: '0', end: '0', words: [] };
  const start = Math.max(0, line.time), end = singingEnd(line, lineTimeEnd(track, index));
  const existing = timedWords(line);
  const source = existing || [{ time: start, endTime: end, text: line.text }];
  const words = source.flatMap((word, wordIndex) => {
    const units = singingUnits(word.text);
    const finish = word.endTime ?? source[wordIndex + 1]?.time ?? end;
    return units.map((text, index) => ({ text, start: (word.time + (finish - word.time) * index / units.length).toFixed(3), end: (word.time + (finish - word.time) * (index + 1) / units.length).toFixed(3) }));
  });
  return { start: start.toFixed(3), end: end.toFixed(3), words };
}

export function changeSingingEnd(draft: LineTimeDraft, value: string): LineTimeDraft {
  const start = Number(draft.start), before = Math.max(Number(draft.end) || 0, ...draft.words.map((word) => Number(word.end) || 0)), end = Number(value);
  // Only compress overflowing drafts. Already calibrated words are left alone.
  if (!value.trim() || !Number.isFinite(end) || end <= start || before <= start || !draft.words.some((word) => Number(word.end) > end)) return { ...draft, end: value };
  const scale = (time: string) => (start + (Number(time) - start) * (end - start) / (before - start)).toFixed(3);
  return { ...draft, end: value, words: draft.words.map((word) => ({ ...word, start: scale(word.start), end: scale(word.end) })) };
}

export function prepareLyricRegeneration(track: Pick<Track, 'lyrics' | 'duration'>, drafts: Record<number, LineTimeDraft> = {}, lineIds?: number[]): LyricLine[] {
  const selected = (index: number) => (!lineIds || lineIds.includes(index)) && vocalLine(track.lyrics[index]);
  const anchors = track.lyrics.map((line, index) => selected(index) && drafts[index] ? { ...line, time: drafts[index].start.trim() ? Number(drafts[index].start) : NaN } : line);
  return anchors.map((line, index) => {
    if (!selected(index)) return line;
    const draft = drafts[index];
    const previous = anchors.slice(0, index).filter((line) => line.time >= 0).at(-1)?.time ?? 0;
    const boundary = lineTimeEnd({ ...track, lyrics: anchors }, index);
    if (!Number.isFinite(line.time) || (line.time >= 0 && (line.time < previous || line.time >= boundary)) || (draft && line.time < 0)) throw new Error(`第 ${index + 1} 句开始时间无效，请先调整再重新生成。`);
    // Saved AI ends may be wrong too. Only this editing session's changed end
    // is a hard bound; otherwise re-evaluate the full original line interval.
    const changedEnd = draft && draft.end !== createLineTimeDraft(track, index).end;
    const endTime = changedEnd && draft.end.trim() ? Number(draft.end) : undefined;
    if (changedEnd && (endTime === undefined || !Number.isFinite(endTime) || endTime <= line.time || endTime > boundary)) throw new Error(`第 ${index + 1} 句唱完时间无效，请先调整再重新生成。`);
    return { ...line, words: undefined, endTime, wordTiming: undefined, timingNote: undefined };
  });
}
export function applyLineTimeDraft(track: Pick<Track, 'lyrics' | 'duration'>, index: number, draft: LineTimeDraft): LyricLine {
  const line = track.lyrics[index];
  const start = draft.start.trim() ? Number(draft.start) : NaN;
  const previous = track.lyrics.slice(0, index).filter((line) => line.time >= 0).at(-1)?.time ?? 0;
  const boundary = lineTimeEnd(track, index);
  const end = draft.end.trim() ? Number(draft.end) : NaN;
  if (!line || !Number.isFinite(start) || start < previous || !Number.isFinite(boundary) || start >= boundary) throw new Error('本句开始时间应在上一句开始与下一句开始之间。');
  if (!Number.isFinite(end) || end <= start || end > boundary) throw new Error('本句唱完时间应晚于本句开始，且不能超过下一句开始或歌曲结尾；间奏不计入演唱时间。');
  if (!draft.words.length || draft.words.map((word) => word.text).join('') !== line.text) throw new Error('逐字草稿与原文不一致，请还原草稿后重新调整。');
  let previousEnd = start;
  const words: LyricWord[] = draft.words.map((word, wordIndex) => {
    const time = word.start.trim() ? Number(word.start) : NaN, endTime = word.end.trim() ? Number(word.end) : NaN;
    if (!Number.isFinite(time) || !Number.isFinite(endTime) || time < previousEnd || endTime <= time || endTime > end) throw new Error(`第 ${wordIndex + 1} 个字词时间无效：需按顺序、不重叠，并在 ${start.toFixed(3)}–${end.toFixed(3)} 秒内。`);
    previousEnd = endTime;
    return { text: word.text, time, endTime };
  });
  const result = { ...line, time: start, endTime: end, words };
  if (!timedWords(result)) throw new Error('逐字时间无效，原歌词保留。');
  return result;
}
