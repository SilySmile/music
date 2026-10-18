import { sha256 } from '@noble/hashes/sha2.js';
import type { AIConfig, LyricLine, LyricWord, Track } from '../types';
import { lineEndMetadata, timedWords } from './lyricTiming';
import { normalizeAIUrl } from './network';

export type SpeechWord = { word: string; start: number; end: number };
export type AlignmentResult = { lyrics: LyricLine[]; matched: number; unmatched: number; existing: number; issues?: { line: number; reason: string }[]; rounds?: number; interrupted?: boolean };
export const normalizeSpeechText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const vocalLine = (line: LyricLine) => !!normalizeSpeechText(line.text) && !/^\s*(?:作[词曲]|编曲|词|曲|制作人|演唱|歌手|专辑|歌名|录音(?:师)?|混音(?:师)?|母带(?:工程师)?|和声(?:编写)?|监制|出品(?:人)?|发行|lyrics?|music|arrang(?:er|ement)|vocal|producer|record(?:ing|ed by)?|mix(?:ing|ed by)?|master(?:ing|ed by)?)\s*[:：]/i.test(line.text);
export const needsWordAlignment = (track: Pick<Track, 'lyrics'>) => track.lyrics.some((line) => vocalLine(line) && !timedWords(line));
export function alignmentSignature(track: Pick<Track, 'id' | 'lyrics'>, config: Pick<AIConfig, 'url' | 'audioModel' | 'model' | 'alignmentMode' | 'singingHint'>) {
  const audio = config.alignmentMode === 'audio';
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify([track.id, audio ? normalizeAudioAIUrl(config.url) : normalizeAIUrl(config.url), audio ? config.audioModel || 'whisper-1' : [config.model, config.singingHint || ''], track.lyrics.map(({ time, text }) => [time, text])]))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function normalizeAudioAIUrl(value: string) {
  const url = new URL(normalizeAIUrl(value));
  let base = url.pathname.replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
  if (url.hostname === 'api.openai.com' && !base) base = '/v1';
  url.pathname = `${base}/audio/transcriptions`;
  return url.href;
}
export function validateAudioAI(config: AIConfig) {
  const url = normalizeAudioAIUrl(config.url);
  if (!config.key.trim()) throw new Error('请先保存 AI 服务地址和 API Key。');
  if (new URL(url).hostname === 'api.deepseek.com') throw new Error('当前 DeepSeek 官方服务不能返回音频逐字时间戳。请配置支持音频识别和字词时间戳的服务；翻译模型不能代替音频识别。');
  return url;
}

export function readSpeechWords(data: unknown, duration: number): SpeechWord[] {
  const words = (data as { words?: unknown })?.words;
  if (!Array.isArray(words) || !words.length || words.length > 50000) throw new Error('音频服务没有返回字词时间戳。请确认音频模型支持 verbose_json 和 word 时间戳；未生成估算时间轴。');
  let last = -1;
  return words.map((word) => {
    if (!word || typeof word.word !== 'string' || word.word.length > 6000 || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || word.start < last || (duration > 0 && word.end > duration + .5)) throw new Error('音频识别的字词时间戳无效，原歌词保留。');
    last = word.start;
    return { word: word.word, start: word.start, end: word.end };
  }).filter((word) => normalizeSpeechText(word.word));
}

// Match complete recognized words against the unchanged source. Do not divide a
// multi-character ASR word into fabricated equal-duration character timestamps.
function sourceWords(text: string, words: SpeechWord[]): LyricWord[] | undefined {
  const characters = [...text];
  const pieces: LyricWord[] = [];
  let cursor = 0;
  for (const word of words) {
    const begin = cursor;
    const expected = normalizeSpeechText(word.word);
    let actual = '';
    while (cursor < characters.length && actual.length < expected.length) actual += normalizeSpeechText(characters[cursor++]);
    while (cursor < characters.length && !normalizeSpeechText(characters[cursor])) cursor++;
    if (actual !== expected) return;
    pieces.push({ time: word.start, endTime: word.end, text: characters.slice(begin, cursor).join('') });
  }
  return cursor === characters.length ? pieces : undefined;
}

export function alignSpeechWords(lines: LyricLine[], speech: SpeechWord[]): AlignmentResult {
  const normalized = speech.map((word) => normalizeSpeechText(word.word));
  let cursor = 0;
  let previousTime = -1;
  let matched = 0, unmatched = 0, existing = 0;
  const lyrics = lines.map((line, index) => {
    if (timedWords(line)) { existing++; previousTime = Math.max(previousTime, line.time); return line; }
    if (!vocalLine(line)) { previousTime = Math.max(previousTime, line.time); return line; }
    const target = normalizeSpeechText(line.text);
    const nextTime = Math.min(lines.slice(index + 1).find((next) => next.time >= 0)?.time ?? Infinity, lineEndMetadata(line).endTime ?? Infinity);
    const candidates: { start: number; end: number; distance: number }[] = [];
    for (let start = cursor; start < speech.length; start++) {
      if (speech[start].start < previousTime || speech[start].start >= nextTime) continue;
      if (line.time >= 0 && Math.abs(speech[start].start - line.time) > 8) continue;
      let text = '';
      for (let end = start; end < speech.length && text.length < target.length; end++) {
        text += normalized[end];
        if (text === target) candidates.push({ start, end: end + 1, distance: line.time >= 0 ? Math.abs(speech[start].start - line.time) : start });
        if (!target.startsWith(text)) break;
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      const words = sourceWords(line.text, speech.slice(candidate.start, candidate.end));
      if (!words || words.some((word, wordIndex) => word.time < (words[wordIndex - 1]?.endTime ?? 0) || word.endTime! > nextTime)) continue;
      const result = { ...line, time: words[0].time, endTime: words.at(-1)!.endTime, words };
      if (!timedWords(result)) continue;
      cursor = candidate.end; previousTime = result.time; matched++;
      return result;
    }
    unmatched++; previousTime = Math.max(previousTime, line.time);
    return line;
  });
  return { lyrics, matched, unmatched, existing };
}
