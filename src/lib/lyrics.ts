import type { LyricLine, LyricWord } from '../types';
import { timedWords } from './lyricTiming';

const seconds = (minutes: string, whole: string, fraction = '0') => Number(minutes) * 60 + Number(whole) + Number(`0.${fraction}`);

function enhancedWords(source: string, start: number, offset: number): { text: string; words?: LyricWord[] } {
  const tags = [...source.matchAll(/<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g)];
  if (!tags.length) return { text: source.trim() };
  const words: LyricWord[] = [];
  const prefix = source.slice(0, tags[0].index).trimStart();
  const tagTime = (tag: RegExpMatchArray) => Math.max(0, seconds(tag[1], tag[2], tag[3]) + offset);
  if (prefix) words.push({ time: start, endTime: tagTime(tags[0]), text: prefix });
  for (const [index, tag] of tags.entries()) {
    const text = source.slice(tag.index! + tag[0].length, tags[index + 1]?.index);
    if (text) words.push({ time: tagTime(tag), ...(tags[index + 1] ? { endTime: tagTime(tags[index + 1]) } : {}), text });
  }
  if (words.length) { words[0].text = words[0].text.trimStart(); words.at(-1)!.text = words.at(-1)!.text.trimEnd(); }
  const text = words.map((word) => word.text).join('');
  const valid = timedWords({ time: start, text, words: words.filter((word) => word.text) });
  return { text, ...(valid ? { words: valid } : {}) };
}

export function parseLyrics(source: string): LyricLine[] {
  const entries: LyricLine[] = [];
  const offset = Number(source.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    // YRC supplies explicit start and duration for each sung word (milliseconds).
    const yrc = rawLine.trim().match(/^\[(\d+),(\d+)\](.*)$/);
    if (yrc) {
      const tags = [...yrc[3].matchAll(/\((\d+),(\d+),\d+\)([^]*?)(?=\(\d+,\d+,\d+\)|$)/g)];
      const words = tags.map((tag) => ({ time: Math.max(0, Number(tag[1]) / 1000 + offset), endTime: Math.max(0, (Number(tag[1]) + Number(tag[2])) / 1000 + offset), text: tag[3] }));
      if (words.length) {
        words[0].text = words[0].text.trimStart(); words[words.length - 1].text = words.at(-1)!.text.trimEnd();
        const line = { time: Math.max(0, Number(yrc[1]) / 1000 + offset), text: words.map((word) => word.text).join(''), words: words.filter((word) => word.text) };
        if (line.text) entries.push(timedWords(line) ? line : { time: line.time, text: line.text });
      }
      continue;
    }
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const endTag = rawLine.match(/\[x-end:(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/i);
    const firstTime = timestamps[0] ? seconds(timestamps[0][1], timestamps[0][2], timestamps[0][3]) : 0;
    const { text, words } = enhancedWords(rawLine.replace(/\[[^\]]*\]/g, ''), Math.max(0, firstTime + offset), offset);
    if (!text) continue;
    for (const timestamp of timestamps) {
      const time = Math.max(0, seconds(timestamp[1], timestamp[2], timestamp[3]) + offset);
      const endTime = endTag ? seconds(endTag[1], endTag[2], endTag[3]) + offset + seconds(timestamp[1], timestamp[2], timestamp[3]) - firstTime : NaN;
      entries.push({
        time,
        ...(Number.isFinite(endTime) && endTime > time ? { endTime } : {}),
        text,
        ...(words ? { words: words.map((word) => { const delta = seconds(timestamp[1], timestamp[2], timestamp[3]) - firstTime; return { ...word, time: Math.max(0, word.time + delta), ...(word.endTime !== undefined ? { endTime: Math.max(0, word.endTime + delta) } : {}) }; }) } : {}),
      });
    }
  }
  if (!entries.length) {
    return source.split(/\r?\n/).map((text) => text.trim()).filter((text) => text && !/^\[.*\]$/.test(text)).map((text) => ({ time: -1, text }));
  }
  const merged: LyricLine[] = [];
  for (const entry of entries.sort((first, second) => first.time - second.time)) {
    const previous = merged.at(-1);
    if (previous && Math.abs(previous.time - entry.time) < 0.01) {
      previous.translation = [previous.translation, entry.text].filter(Boolean).join(' / ');
    } else merged.push({ ...entry });
  }
  if (/\[x-timing:estimated\]/i.test(source)) for (const line of merged) if (line.words) line.wordTiming = 'estimated';
  return merged;
}

export function mergeTranslation(original: LyricLine[], translation: LyricLine[]): LyricLine[] {
  if (!original.length) return translation;
  const timed = translation.some((line) => line.time >= 0);
  return original.map((line, index) => {
    const matched = timed
      ? translation.find((candidate) => candidate.time >= 0 && Math.abs(candidate.time - line.time) < 0.3)
      : translation[index];
    return { ...line, translation: matched?.text ?? line.translation };
  });
}

export function activeLyricIndex(lines: LyricLine[], time: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].time >= 0 && lines[index].time <= time) active = index;
  }
  return active;
}

export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}
