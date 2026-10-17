import type { LyricLine, LyricWord } from '../types';

// Only use timings that cover the displayed source text, in source order.
export function timedWords(line: Pick<LyricLine, 'time' | 'text' | 'words'>): LyricWord[] | undefined {
  const words = line.words;
  if (line.time < 0 || !Array.isArray(words) || !words.length || words.length > 6000) return;
  let previous = line.time;
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !word.text.length || !Number.isFinite(word.time) || word.time < previous || (word.endTime !== undefined && (!Number.isFinite(word.endTime) || word.endTime < word.time))) return;
    previous = word.time;
  }
  return words.map((word) => word.text).join('') === line.text ? words : undefined;
}

export function wordProgress(word: LyricWord, position: number, nextStart?: number): number {
  if (!Number.isFinite(position) || position < word.time) return 0;
  const end = word.endTime ?? nextStart;
  // Without an end marker, reveal the final word at its known start; never
  // stretch it to the next line, which can include a long instrumental break.
  if (end === undefined || end <= word.time) return 100;
  return Math.max(0, Math.min(100, (position - word.time) / (end - word.time) * 100));
}

export function lyricTimestamp(seconds: number, precision = 3) {
  const scale = 10 ** precision;
  const ticks = Math.round(Math.max(0, seconds) * scale);
  return `${String(Math.floor(ticks / (60 * scale))).padStart(2, '0')}:${String(Math.floor(ticks / scale) % 60).padStart(2, '0')}.${String(ticks % scale).padStart(precision, '0')}`;
}

export function enhancedLyricText(line: LyricLine): string {
  const words = timedWords(line);
  if (!words) return line.text;
  return words.map((word, index) => `<${lyricTimestamp(word.time)}>${word.text}${word.endTime !== undefined && word.endTime !== words[index + 1]?.time ? `<${lyricTimestamp(word.endTime)}>` : ''}`).join('');
}

export function extrapolateLyricPosition(position: number, elapsedMs: number, advancing: boolean, playbackRate = 1): number {
  // Frequent authoritative audio samples keep this smooth. Stop extrapolating
  // if samples stop, rather than running ahead during buffering or suspension.
  return position + (advancing ? Math.min(100, Math.max(0, elapsedMs)) / 1000 * playbackRate : 0);
}
