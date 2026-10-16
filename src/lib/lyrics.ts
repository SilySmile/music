import type { LyricLine } from '../types';

export function parseLyrics(source: string): LyricLine[] {
  const entries: LyricLine[] = [];
  const offset = Number(source.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = rawLine.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;
    for (const timestamp of timestamps) {
      entries.push({
        time: Math.max(0, Number(timestamp[1]) * 60 + Number(timestamp[2]) + Number(`0.${timestamp[3] ?? '0'}`) + offset),
        text,
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
