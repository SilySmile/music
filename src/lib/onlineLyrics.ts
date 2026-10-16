import type { LyricLine } from '../types';
import { parseLyrics } from './lyrics';
import { serviceRequest, type JsonRequester } from './network';

export type LyricCandidate = { id: number; title: string; artist: string; album: string; duration: number; lyrics: LyricLine[]; synced: boolean };
export type TranslationCache = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<unknown> };
export const languages = [['autodetect', '自动识别'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['fr', '法语'], ['es', '西班牙语'], ['de', '德语'], ['it', '意大利语'], ['ru', '俄语'], ['pt', '葡萄牙语']] as const;

function normalize(text: string) { return text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, ''); }

export function readCandidates(data: unknown, title: string, artist: string, duration: number): LyricCandidate[] {
  if (!Array.isArray(data)) throw new Error('歌词服务返回了无法识别的数据。');
  const candidates: LyricCandidate[] = [];
  for (const item of data.slice(0, 100)) {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.id) || typeof item.trackName !== 'string' || item.instrumental) continue;
    const source = typeof item.syncedLyrics === 'string' && item.syncedLyrics.trim() ? item.syncedLyrics : item.plainLyrics;
    if (typeof source !== 'string' || !source.trim() || source.length > 200000) continue;
    const lyrics = parseLyrics(source);
    if (!lyrics.length) continue;
    candidates.push({ id: item.id, title: item.trackName, artist: typeof item.artistName === 'string' ? item.artistName : '未知艺术家', album: typeof item.albumName === 'string' ? item.albumName : '', duration: Number.isFinite(item.duration) ? item.duration : 0, lyrics, synced: lyrics.some((line) => line.time >= 0) });
  }
  const score = (candidate: LyricCandidate) => (normalize(candidate.title) === normalize(title) ? 100 : 0) + (artist && normalize(candidate.artist) === normalize(artist) ? 60 : 0) + (candidate.synced ? 5 : 0) - (duration > 0 && candidate.duration > 0 ? Math.min(30, Math.abs(candidate.duration - duration)) : 0);
  return candidates.sort((first, second) => score(second) - score(first)).slice(0, 20);
}

export async function findLyrics(title: string, artist: string, duration: number, signal?: AbortSignal, request: JsonRequester = serviceRequest) {
  if (!title.trim()) throw new Error('请先填写歌名。');
  const params: Record<string, string> = { track_name: title.trim().slice(0, 200) };
  if (artist.trim() && artist !== '未知艺术家') params.artist_name = artist.trim().slice(0, 200);
  return readCandidates(await request({ service: 'lyrics', params }, signal), title, artist, duration);
}

export function needsTranslation(line: LyricLine) {
  if (line.translation?.trim()) return false;
  return /[\p{L}]/u.test(line.text) && !(/\p{Script=Han}/u.test(line.text) && !/[\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(line.text));
}

export function splitTranslationText(text: string, maximumBytes = 450): string[] {
  const chunks: string[] = [];
  let current = '';
  let byteCount = 0;
  const encoder = new TextEncoder();
  for (const character of text) {
    const characterBytes = encoder.encode(character).length;
    if (byteCount + characterBytes > maximumBytes && current) { chunks.push(current); current = ''; byteCount = 0; }
    current += character;
    byteCount += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function decodeTranslation(text: string): string {
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const value = entity.toLowerCase().startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
  }).trim();
}

export async function translateMissingLyrics(lines: LyricLine[], language: string, options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void; request?: JsonRequester; cache?: TranslationCache } = {}) {
  const lyrics = lines.map((line) => ({ ...line }));
  const targets = [...new Set(lines.filter(needsTranslation).map((line) => line.text))];
  const memory = new Map<string, string>();
  let completed = 0;
  let translatedCount = 0;
  let error: string | undefined;
  let cancelled = false;
  const request = options.request ?? serviceRequest;
  const sourceLanguage = languages.some(([value]) => value === language) ? language : 'autodetect';
  options.onProgress?.(0, targets.length);
  for (const text of targets) {
    try {
      options.signal?.throwIfAborted();
      const chunks = splitTranslationText(text);
      const translatedChunks: string[] = [];
      for (const chunk of chunks) {
        options.signal?.throwIfAborted();
        const key = `${sourceLanguage}|zh-CN|${chunk}`;
        let translated = memory.get(key) ?? await options.cache?.get(key);
        if (!translated) {
          const response = await request({ service: 'translation', params: { q: chunk, langpair: `${sourceLanguage}|zh-CN` } }, options.signal) as { responseStatus?: number | string; quotaFinished?: boolean; responseDetails?: string; responseData?: { translatedText?: string } };
          if (response?.quotaFinished || Number(response?.responseStatus) === 429) throw new Error('翻译服务的免费额度已用完，已完成的译文会保存，请稍后继续。');
          const value = response?.responseData?.translatedText;
          if (Number(response?.responseStatus) !== 200 || typeof value !== 'string' || !value.trim() || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR/i.test(value)) throw new Error('翻译服务暂时无法处理这段歌词，请稍后重试或选择原文语言。');
          translated = decodeTranslation(value);
          memory.set(key, translated);
          await options.cache?.set(key, translated);
        }
        translatedChunks.push(translated);
      }
      const translation = translatedChunks.join('');
      lyrics.forEach((line) => { if (line.text === text && needsTranslation(line)) { line.translation = translation; translatedCount++; } });
      completed++;
      options.onProgress?.(completed, targets.length);
    } catch (caught) {
      if (options.signal?.aborted || (caught instanceof Error && caught.name === 'AbortError')) cancelled = true;
      else error = caught instanceof Error ? caught.message : '网络不可用，请联网后重试。';
      break;
    }
  }
  return { lyrics, translatedCount, remaining: lyrics.filter(needsTranslation).length, error, cancelled };
}
