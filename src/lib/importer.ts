import { BlobReader, BlobWriter, ZipReader, configure } from '@zip.js/zip.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseBlob } from 'music-metadata';
import type { Track } from '../types';
import { decodeText, mergeTranslation, parseLyrics } from './lyrics';

type Entry = { name: string; size: number; id: string; group: string; read: (signal?: AbortSignal) => Promise<Blob> };
type ImportOptions = { signal?: AbortSignal; completed?: Set<string>; findExisting?(id: string): Promise<Track | undefined>; onTotal?(count: number): Promise<void>; onTrack?(track: Track | undefined, entry: string): Promise<void>; collect?: boolean };
const audioPattern = /\.(mp3|flac|wav|m4a|aac|ogg|opus)$/i;
const mimeTypes: Record<string, string> = { mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg' };
configure({ useWebWorkers: false });

function key(name: string) { return name.replace(/\\/g, '/').normalize('NFC').toLowerCase(); }

async function entriesFromFiles(files: File[]) {
  const entries: Entry[] = [];
  const readers: ZipReader<Blob>[] = [];
  for (const file of files) {
    const sourceId = `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
    if (/\.zip$/i.test(file.name)) {
      const reader = new ZipReader(new BlobReader(file), { decodeText: (bytes) => decodeText(Uint8Array.from(bytes).buffer) });
      readers.push(reader);
      for (const entry of await reader.getEntries()) {
        if (entry.directory || entry.filename.includes('__MACOSX/') || !entry.getData) continue;
        const id = `${sourceId}:${entry.filename}:${entry.uncompressedSize}:${entry.signature}`;
        entries.push({ name: entry.filename, size: entry.uncompressedSize, id, group: sourceId, read: (signal) => entry.getData!(new BlobWriter(), { signal, checkSignature: true }) as Promise<Blob> });
      }
    } else {
      entries.push({ name: file.webkitRelativePath || file.name, size: file.size, id: sourceId, group: 'loose', read: async () => file });
    }
  }
  return { entries, close: () => Promise.all(readers.map((reader) => reader.close())) };
}

export async function importFiles(files: File[], onProgress: (message: string) => void, options: ImportOptions = {}): Promise<{ tracks: Track[]; warnings: string[] }> {
  onProgress('正在读取文件…');
  options.signal?.throwIfAborted();
  const { entries, close } = await entriesFromFiles(files);
  try {
  const lookup = new Map(entries.map((entry) => [`${entry.group}|${key(entry.name)}`, entry]));
  const audioEntries = entries.filter((entry) => audioPattern.test(entry.name));
  if (!audioEntries.length) throw new Error('没有找到歌曲。请选择包含音频文件的 ZIP，或直接选择歌曲和歌词。');
  await options.onTotal?.(audioEntries.length);
  const tracks: Track[] = [];
  const imported = new Map<string, Track>();
  const warnings: string[] = [];
  const restoredMetadata = new Map<string, Partial<Track>>();
  for (const entry of entries.filter((entry) => /(^|\/)tingyu-library\.json$/i.test(entry.name))) {
    try {
      if (entry.size > 5 * 1024 * 1024) throw new Error('清单过大');
      const manifest = JSON.parse(decodeText(await (await entry.read(options.signal)).arrayBuffer()));
      if (!['tingyu-library', 'xianqiji-library'].includes(manifest.format) || manifest.version !== 1 || !Array.isArray(manifest.tracks)) throw new Error('清单版本不支持');
      for (const item of manifest.tracks) {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id)) continue;
        const metadata: Partial<Track> = { favorite: item.favorite === true };
        for (const field of ['title', 'artist', 'album', 'lyricsSource', 'translationSource'] as const) {
          if (typeof item[field] === 'string' && item[field].trim()) metadata[field] = item[field].slice(0, 500);
        }
        for (const field of ['addedAt', 'lastPlayed'] as const) { if (Number.isFinite(item[field]) && item[field] > 0) metadata[field] = item[field]; }
        const audit = item.translationAudit;
        if (audit && typeof audit.song === 'string' && typeof audit.artist === 'string' && typeof audit.model === 'string' && Number.isFinite(audit.verifiedAt) && Number.isSafeInteger(audit.checkedLines) && audit.checkedLines >= 0) metadata.translationAudit = { song: audit.song.slice(0, 500), artist: audit.artist.slice(0, 500), model: audit.model.slice(0, 500), verifiedAt: audit.verifiedAt, checkedLines: audit.checkedLines };
        if (Array.isArray(item.lyrics) && item.lyrics.length <= 5000 && item.lyrics.every((line: { time?: unknown; text?: unknown; translation?: unknown }) => typeof line.time === 'number' && Number.isFinite(line.time) && line.time >= -1 && typeof line.text === 'string' && line.text.length <= 6000 && (line.translation === undefined || typeof line.translation === 'string' && line.translation.length <= 6000))) {
          metadata.lyrics = item.lyrics.map((line: { time: number; text: string; translation?: string }) => ({ time: line.time, text: line.text, translation: line.translation }));
        }
        restoredMetadata.set(item.id, metadata);
      }
    } catch { warnings.push('音乐迁移清单未能读取，歌曲与同名歌词仍可正常导入。'); }
  }
  for (const [index, entry] of audioEntries.entries()) {
    options.signal?.throwIfAborted();
    if (options.completed?.has(entry.id)) continue;
    onProgress(`正在导入 ${index + 1} / ${audioEntries.length} · ${entry.name.split('/').at(-1)}`);
    try {
      const relativeBase = key(entry.name.replace(audioPattern, ''));
      const base = `${entry.group}|${relativeBase}`;
      const directory = `${entry.group}|${relativeBase.includes('/') ? relativeBase.slice(0, relativeBase.lastIndexOf('/') + 1) : ''}`;
      const format = entry.name.split('.').at(-1)!.toLowerCase();
      const audio = new Blob([await entry.read(options.signal)], { type: mimeTypes[format] });
      const hasher = sha256.create();
      for (let offset = 0; offset < audio.size; offset += 4 * 1024 * 1024) {
        options.signal?.throwIfAborted();
        hasher.update(new Uint8Array(await audio.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()));
      }
      const id = Array.from(hasher.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const existing = imported.get(id) ?? await options.findExisting?.(id);
      if (existing) {
        options.signal?.throwIfAborted();
        onProgress(`音频已存在，导入成功 · ${existing.title}`);
        await options.onTrack?.(existing, entry.id);
        if (options.collect !== false && !imported.has(id)) tracks.push(existing);
        imported.set(id, existing);
        continue;
      }
      const filename = entry.name.replace(/\\/g, '/').split('/').at(-1)!.replace(audioPattern, '');
      const parts = filename.split(' - ');
      let title = parts.length > 1 ? parts.slice(1).join(' - ') : filename;
      let artist = parts.length > 1 ? parts[0] : '未知艺术家';
      let album = '本地音乐';
      let duration = 0;
      let cover: Blob | undefined;
      try {
        const metadata = await parseBlob(audio, { duration: true });
        title = metadata.common.title || title;
        artist = metadata.common.artist || artist;
        album = metadata.common.album || album;
        duration = metadata.format.duration || 0;
        const picture = metadata.common.picture?.[0];
        if (picture) cover = new Blob([new Uint8Array(picture.data)], { type: picture.format });
      } catch { warnings.push(`${filename}：未读到标签，已使用文件名。`); }
      const lyricEntry = lookup.get(`${base}.lrc`) ?? lookup.get(`${base}.txt`);
      const translatedEntry = ['.zh.lrc', '.zh-cn.lrc', '.translated.lrc', '.cn.lrc', '.zh.txt'].map((suffix) => lookup.get(base + suffix)).find(Boolean);
      let lyrics = lyricEntry ? parseLyrics(decodeText(await (await lyricEntry.read(options.signal)).arrayBuffer())) : [];
      if (translatedEntry) lyrics = mergeTranslation(lyrics, parseLyrics(decodeText(await (await translatedEntry.read(options.signal)).arrayBuffer())));
      const coverEntry = ['.jpg', '.png', '.webp', '.jpeg'].map((suffix) => lookup.get(base + suffix) ?? lookup.get(`${directory}cover${suffix}`) ?? lookup.get(`${directory}folder${suffix}`)).find(Boolean);
      if (coverEntry) cover = new Blob([await coverEntry.read(options.signal)], { type: /\.png$/i.test(coverEntry.name) ? 'image/png' : /\.webp$/i.test(coverEntry.name) ? 'image/webp' : 'image/jpeg' });
      const track = { id, title, artist, album, duration, format: format.toUpperCase(), audio, cover, lyrics, lyricsSource: lyrics.length ? '本地导入' : undefined, translationSource: lyrics.some((line) => line.translation) ? '本地译文' : undefined, favorite: false, addedAt: Date.now() + index, ...restoredMetadata.get(id) };
      options.signal?.throwIfAborted();
      await options.onTrack?.(track, entry.id);
      imported.set(id, track);
      if (options.collect !== false) tracks.push(track);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('设备空间不足。已完成的歌曲已保留，释放空间后可继续。');
      warnings.push(`${entry.name}：${error instanceof Error ? error.message : '导入失败'}`);
    }
  }
  if (!tracks.length && options.collect !== false && !options.completed?.size) throw new Error(`歌曲未能导入。${warnings[0] ?? ''}`);
  return { tracks, warnings };
  } finally { await close(); }
}
