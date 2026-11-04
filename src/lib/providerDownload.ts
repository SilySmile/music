import { parseBlob } from 'music-metadata';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Track } from '../types';
import type { ProviderSearchResult } from './providerSearch';
import { validateProviderAudioUrl } from './providerSearch';
import { Capacitor, registerPlugin } from '@capacitor/core';
export type ProviderSaveTarget = { destination: 'local' | 'server'; scope: string; source?: import('./onlineSource').SourceConfig };

const native = registerPlugin<{
  download(options: { id: string; provider: string; url: string }): Promise<{ token: string; size: number; type: string }>;
  downloadState(options: { id: string }): Promise<{ bytes: number; total: number }>;
  cancel(options: { id: string }): Promise<void>;
  readDownload(options: { token: string; offset: number; length: number }): Promise<{ data: string }>;
  removeDownload(options: { token: string }): Promise<void>;
}>('MusicProviders');

/** Transfer in the native process so background WebView suspension does not stop the download. */
export async function downloadProviderAudio(song: ProviderSearchResult, url: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<Blob> {
  validateProviderAudioUrl(song.provider, url); signal.throwIfAborted();
  const id = crypto.randomUUID(), bridge = window.tingyuDesktop;
  if (!bridge && Capacitor.getPlatform() !== 'android') throw Error('请在安装版中下载音频。');
  const cancel = () => { void (bridge ? bridge.cancelProvider(id) : native.cancel({ id })).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let polling = false, complete: { token: string; size: number; type: string } | undefined;
  const timer = setInterval(() => { if (polling || signal.aborted) return; polling = true; void (bridge ? bridge.providerDownloadState(id) : native.downloadState({ id })).then((value) => { if (!signal.aborted) progress(value.bytes); }).catch(() => {}).finally(() => { polling = false; }); }, 700);
  try {
    complete = await (bridge ? bridge.downloadProvider({ id, provider: song.provider, url }) : native.download({ id, provider: song.provider, url }));
    signal.throwIfAborted();
    if (!Number.isSafeInteger(complete.size) || complete.size <= 0 || complete.size > providerDownloadLimit) throw Error('音频文件大小无效。');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < complete.size; offset += 1024 * 1024) {
      signal.throwIfAborted(); const length = Math.min(1024 * 1024, complete.size - offset);
      const bytes = bridge ? Uint8Array.from(await bridge.readProviderDownload(complete.token, offset, length)) : Uint8Array.from(atob((await native.readDownload({ token: complete.token, offset, length })).data), (value) => value.charCodeAt(0));
      if (bytes.length !== length) throw Error('音频下载不完整，未加入音乐库。'); parts.push(bytes);
    }
    signal.throwIfAborted(); progress(complete.size); return new Blob(parts, { type: complete.type });
  } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); if (complete) await (bridge ? bridge.removeProviderDownload(complete.token) : native.removeDownload({ token: complete.token })).catch(() => {}); }
}

export const providerDownloadLimit = 200 * 1024 * 1024;
async function validateContainerBounds(blob: Blob) {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const tag = (start: number, length: number) => String.fromCharCode(...head.slice(start, start + length));
  if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE' && new DataView(head.buffer).getUint32(4, true) + 8 > blob.size) throw Error('音频容器不完整，未加入音乐库。');
  if (tag(4, 4) !== 'ftyp') return;
  let offset = 0, boxes = 0; const types = new Set<string>();
  while (offset < blob.size) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + 16).arrayBuffer());
    if (bytes.length < 8 || ++boxes > 100000) throw Error('音频容器不完整，未加入音乐库。');
    const view = new DataView(bytes.buffer); const size32 = view.getUint32(0); const header = size32 === 1 ? 16 : 8;
    if (bytes.length < header) throw Error('音频容器不完整，未加入音乐库。');
    const size = size32 === 0 ? blob.size - offset : size32 === 1 ? Number(view.getBigUint64(8)) : size32;
    if (!Number.isSafeInteger(size) || size < header || offset + size > blob.size) throw Error('音频容器不完整，未加入音乐库。');
    types.add(String.fromCharCode(...bytes.slice(4, 8))); offset += size;
  }
  if (!types.has('moov') || !types.has('mdat')) throw Error('音频容器缺少必要数据，未加入音乐库。');
}
export async function readProviderDownload(response: Response, signal: AbortSignal, progress: (bytes: number) => void): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）。`);
  const length = Number(response.headers.get('content-length'));
  if (length > providerDownloadLimit) { await response.body.cancel(); throw new Error('当前单首下载上限为 200 MB。'); }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > providerDownloadLimit) throw new Error('当前单首下载上限为 200 MB。');
      parts.push(Uint8Array.from(value)); progress(size);
    }
    if (!size || (length > 0 && size !== length)) throw new Error('音频下载不完整，未加入音乐库。');
    return new Blob(parts, { type: response.headers.get('content-type') || 'application/octet-stream' });
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Reject an HTML error page, truncated audio, and a preview mislabeled as a whole song. */
export async function prepareProviderTrack(blob: Blob, song: ProviderSearchResult, signal: AbortSignal, lyrics: Track['lyrics'] = []): Promise<Track> {
  signal.throwIfAborted();
  if (!blob.size || blob.size > providerDownloadLimit) throw new Error('音频为空或超过单首下载上限。');
  await validateContainerBounds(blob); signal.throwIfAborted();
  const metadata = await parseBlob(blob, { duration: true }).catch(() => { throw new Error('下载内容不是有效音频，未加入音乐库。'); });
  const duration = metadata.format.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) throw new Error('无法核对音频完整时长，未加入音乐库。');
  if (song.duration > 0 && duration < song.duration - Math.max(3, song.duration * .02)) throw new Error('音频时长短于原曲，可能为试听或下载不完整，未加入音乐库。');
  const hasher = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 4 * 1024 * 1024) { signal.throwIfAborted(); hasher.update(new Uint8Array(await blob.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer())); }
  const id = Array.from(hasher.digest(), (value) => value.toString(16).padStart(2, '0')).join('');
  const format = metadata.format.container?.toUpperCase() || 'AUDIO';
  signal.throwIfAborted();
  if (!['MP3', 'MPEG'].includes(format)) throw new Error(`下载内容为 ${format}，不是普通 MP3；未加入音乐库，也未转换受保护文件。`);
  return { id, title: song.title, artist: song.artist, album: song.album, duration, format: 'MP3', audio: blob, lyrics, lyricsSource: lyrics.length ? 'LRCLIB' : undefined, favorite: false, addedAt: Date.now() };
}
