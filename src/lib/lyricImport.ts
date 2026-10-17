import type { LyricLine, Track } from '../types';
import { decodeText, mergeTranslation, parseLyrics } from './lyrics';

export type LyricFile = { name: string; lines: LyricLine[]; role: 'original' | 'translation'; trackId: string };
const translationSuffix = /[._ -](?:zh(?:-cn)?|cn|translated|translation|中文|译文)$/i;
function normalized(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }

export async function readLyricFile(file: File, tracks: Track[]): Promise<LyricFile> {
  if (!/\.(lrc|yrc|txt)$/i.test(file.name)) throw new Error(`不支持的歌词格式：${file.name}`);
  const stem = file.name.replace(/\.(lrc|yrc|txt)$/i, '');
  const role = translationSuffix.test(stem) ? 'translation' : 'original';
  const title = normalized(stem.replace(translationSuffix, ''));
  const exact = tracks.filter((track) => [track.title, `${track.artist}${track.title}`, `${track.title}${track.artist}`].some((value) => normalized(value) === title));
  const lines = parseLyrics(decodeText(await file.arrayBuffer()));
  if (!lines.length) throw new Error(`歌词为空：${file.name}`);
  return { name: file.name, lines, role, trackId: exact.length === 1 ? exact[0].id : '' };
}

export function lyricPatches(files: LyricFile[], tracks: Track[]): { trackId: string; patch: Partial<Track> }[] {
  const groups = new Map<string, LyricFile[]>();
  for (const file of files) {
    if (!tracks.some((track) => track.id === file.trackId)) throw new Error(`请为「${file.name}」选择对应歌曲。`);
    groups.set(file.trackId, [...(groups.get(file.trackId) ?? []), file]);
  }
  return [...groups].map(([trackId, entries]) => {
    const track = tracks.find((candidate) => candidate.id === trackId)!;
    if (entries.filter((entry) => entry.role === 'original').length > 1 || entries.filter((entry) => entry.role === 'translation').length > 1) throw new Error(`「${track.title}」只能选择一份原文和一份中文，请移除重复文件。`);
    const original = entries.find((entry) => entry.role === 'original');
    const translation = entries.find((entry) => entry.role === 'translation');
    let lyrics = original ? original.lines.map((line) => {
      const matches = track.lyrics.filter((old) => old.text === line.text);
      const old = matches.find((candidate) => candidate.time === line.time) ?? (matches.length === 1 ? matches[0] : undefined);
      return { ...line, translation: line.translation || old?.translation };
    }) : track.lyrics.map((line) => ({ ...line }));
    if (!lyrics.length) throw new Error(`「${track.title}」尚无原文，请先导入原文歌词，或把文件用途改为原文。`);
    if (translation) {
      const merged = mergeTranslation(lyrics.map((line) => ({ ...line, translation: undefined })), translation.lines);
      const matched = merged.filter((line) => line.translation).length;
      if (!matched) throw new Error(`「${track.title}」译文时间轴未匹配，请检查是否为同一版本的歌词。`);
      lyrics = merged.map((line, index) => ({ ...line, translation: line.translation || lyrics[index].translation }));
    }
    return { trackId, patch: {
      lyrics,
      ...(original ? { lyricsSource: `本地导入：${original.name}` } : {}),
      ...(translation || original?.lines.some((line) => line.translation) ? { translationSource: `本地导入：${translation?.name ?? original!.name}`, translationAudit: undefined } : {}),
    } };
  });
}
