import JSZip from 'jszip';
import { Capacitor } from '@capacitor/core';
import type { LyricLine, Track } from '../types';
import { enhancedLyricText, lyricTimestamp, timedWords } from './lyricTiming';

export type ExportManifest = { format: 'tingyu-library'; version: 1; exportedAt: string; tracks: { id: string; title: string; artist: string; album: string; favorite: boolean; addedAt: number; lastPlayed?: number; lyricsSource?: string; translationSource?: string; lyrics: LyricLine[] }[] };

export function safeFilename(value: string) {
  const result = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 100).trim();
  return result && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? result : '歌曲';
}

export function serializeLyrics(lines: LyricLine[], translated = false) {
  const hasTime = lines.some((line) => line.time >= 0);
  return lines.map((line) => {
    const text = translated ? line.translation ?? '' : enhancedLyricText(line);
    if (!text) return hasTime ? '' : ' ';
    if (line.time < 0) return text;
    if (timedWords(line) || line.endTime !== undefined) return `[${lyricTimestamp(line.time)}]${text}`;
    const hundredths = Math.round(line.time * 100);
    return `[${Math.floor(hundredths / 6000).toString().padStart(2, '0')}:${Math.floor(hundredths / 100 % 60).toString().padStart(2, '0')}.${(hundredths % 100).toString().padStart(2, '0')}]${text}`;
  }).filter((line) => line !== '').join('\n');
}

export async function createMusicArchive(tracks: Track[], onProgress: (message: string) => void, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!tracks.length) throw new Error('请先选择要导出的歌曲。');
  const archive = new JSZip();
  const manifest: ExportManifest = { format: 'tingyu-library', version: 1, exportedAt: new Date().toISOString(), tracks: [] };
  for (const [index, track] of tracks.entries()) {
    signal?.throwIfAborted();
    onProgress(`正在打包 ${index + 1} / ${tracks.length} · ${track.title}`);
    const base = safeFilename(`${track.artist} - ${track.title}`);
    const directory = archive.folder(`${String(index + 1).padStart(3, '0')} - ${safeFilename(track.title)} - ${track.id.slice(0, 8)}`)!;
    const extension = /^[a-z0-9]{2,5}$/i.test(track.format) ? track.format.toLowerCase() : 'mp3';
    directory.file(`${base}.${extension}`, await track.audio.arrayBuffer(), { compression: 'STORE' });
    const timed = track.lyrics.some((line) => line.time >= 0);
    if (track.lyrics.length) directory.file(`${base}.${timed ? 'lrc' : 'txt'}`, serializeLyrics(track.lyrics), { compression: 'DEFLATE' });
    if (track.lyrics.some((line) => line.translation)) directory.file(`${base}.zh.${timed ? 'lrc' : 'txt'}`, serializeLyrics(track.lyrics, true), { compression: 'DEFLATE' });
    if (track.cover) directory.file(`cover.${track.cover.type === 'image/png' ? 'png' : track.cover.type === 'image/webp' ? 'webp' : 'jpg'}`, await track.cover.arrayBuffer(), { compression: 'STORE' });
    manifest.tracks.push({ id: track.id, title: track.title, artist: track.artist, album: track.album, favorite: track.favorite, addedAt: track.addedAt, lastPlayed: track.lastPlayed, lyricsSource: track.lyricsSource, translationSource: track.translationSource, lyrics: track.lyrics.map((line) => ({ ...line })) });
  }
  archive.file('tingyu-library.json', JSON.stringify(manifest, null, 2), { compression: 'DEFLATE' });
  archive.file('导入说明.txt', '在新设备安装弦栖霁，点击「导入音乐」选择整个 ZIP，即可恢复歌曲、封面、双语歌词与收藏记录。原音频保持不变。此包不含 API Key 或其他服务密钥。');
  const bytes = await archive.generateAsync({ type: 'uint8array', streamFiles: true }, (metadata) => { signal?.throwIfAborted(); onProgress(`正在生成 ZIP · ${Math.round(metadata.percent)}%`); });
  return Uint8Array.from(bytes);
}

export async function saveMusicArchive(bytes: Uint8Array<ArrayBuffer>, filename: string, onProgress: (message: string) => void) {
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const path = `exports/${Date.now()}-${filename}`;
    await Filesystem.writeFile({ path, directory: Directory.Cache, data: '', recursive: true });
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + 512 * 1024));
      let binary = '';
      for (let index = 0; index < part.length; index += 8192) binary += String.fromCharCode(...part.subarray(index, index + 8192));
      await Filesystem.appendFile({ path, directory: Directory.Cache, data: btoa(binary) });
      onProgress(`正在写出文件 · ${Math.min(100, Math.round((offset + part.length) / bytes.length * 100))}%`);
    }
    const result = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: '导出弦栖霁', dialogTitle: '保存音乐包或发送到另一台设备', files: [result.uri] });
    return '已打开系统分享，请选择保存到文件或发送到另一台设备。';
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return '音乐包已交给系统保存；换设备后选择该 ZIP 导入即可。';
}
