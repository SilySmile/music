import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Track } from '../types';
import { timedWords, wordTimingMetadata } from './lyricTiming';
import { getTrack, saveStreamedTrack, saveTracks } from './storage';

export type SourceConfig = { baseUrl: string; token: string; remember: boolean; autoSync?: boolean; connected?: boolean; path?: string };
export type SourceRequest = { method: 'GET' | 'POST'; path: string; body?: unknown };
export type SourceMedia = { size: number; type: string; sha256: string };
export type SourceTrack = { metadata: Omit<Track, 'audio' | 'cover'>; audio: SourceMedia; cover?: SourceMedia; revision: number; updatedAt: number };
export type SourceInfo = { product: string; schema: number; canWrite: boolean; trackCount: number; chunkBytes: number; verification?: boolean; publicRead?: boolean; streaming?: boolean };
export type SourceRequester = <Result>(request: SourceRequest, signal?: AbortSignal) => Promise<Result>;
const secure = registerPlugin<{ loadKey(options: { slot: string }): Promise<{ key: string; path: string }>; saveKey(options: { slot: string; key: string }): Promise<void>; clearKey(options: { slot: string }): Promise<void> }>('SecureConfig');
const defaultConfig: SourceConfig = { baseUrl: 'https://39.106.55.218/music-library/', token: '', remember: false };
let memory: SourceConfig | undefined;

export function normalizeSourceUrl(value: string) {
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('请填写不含账号、密码或参数的 HTTPS 曲库地址。');
  url.pathname = url.pathname === '/' ? '/music-library/' : `${url.pathname.replace(/\/+$/, '')}/`; return url.href;
}
export function parseSourceConnection(text: string): SourceConfig {
  if (text.length > 16384) throw new Error('连接配置过大，请选择正确的曲库配置文件。');
  const value = JSON.parse(text);
  if (!value || typeof value.baseUrl !== 'string' || value.format !== 'xianqiji-source-connection' && typeof value.writeToken !== 'string') throw new Error('不是弦栖霁曲库连接配置。');
  if (value.format && value.version !== 1) throw new Error('连接配置版本不支持。');
  const token = value.token || value.writeToken;
  if (typeof token !== 'string' || token.length < 20 || token.length > 1000 || /[\r\n]/.test(token)) throw new Error('连接文件中的曲库密钥无效。');
  return { baseUrl: normalizeSourceUrl(value.baseUrl), token, remember: true, autoSync: false };
}
export async function loadSourceConfig(): Promise<SourceConfig> {
  if (window.tingyuDesktop) return window.tingyuDesktop.getSourceConfig();
  if (memory) return memory;
  if (Capacitor.getPlatform() === 'android') {
    const saved = await secure.loadKey({ slot: 'cloud' });
    if (saved.key) { const config = JSON.parse(saved.key); return { ...config, baseUrl: normalizeSourceUrl(config.baseUrl), autoSync: config.autoSync === true, path: saved.path }; }
    return { ...defaultConfig, baseUrl: localStorage.getItem('xianqiji-source-url') || defaultConfig.baseUrl, connected: localStorage.getItem('xianqiji-source-connected') === 'true', path: saved.path };
  }
  return { ...defaultConfig };
}
export async function saveSourceConfig(config: SourceConfig): Promise<SourceConfig> {
  const next = { baseUrl: normalizeSourceUrl(config.baseUrl), token: config.token.trim(), remember: config.remember, autoSync: config.autoSync === true, connected: config.connected ?? !!config.token };
  if (next.token.length > 1000 || /[\r\n]/.test(next.token)) throw new Error('无效的曲库访问密钥。');
  let saved: SourceConfig = next;
  if (window.tingyuDesktop) saved = await window.tingyuDesktop.saveSourceConfig(next);
  else if (Capacitor.getPlatform() === 'android') {
    if (next.remember && next.token) await secure.saveKey({ slot: 'cloud', key: JSON.stringify(next) }); else await secure.clearKey({ slot: 'cloud' });
    localStorage.setItem('xianqiji-source-url', next.baseUrl);
    localStorage.setItem('xianqiji-source-connected', String(next.connected));
  } else if (next.remember) throw new Error('浏览器预览不能加密保存曲库密钥，请使用 PC 或安卓客户端。');
  memory = saved;
  window.dispatchEvent(new Event('xianqiji-source-config-changed'));
  return saved;
}
export const sourceRequest: SourceRequester = async <Result>(request: SourceRequest, signal?: AbortSignal): Promise<Result> => {
  signal?.throwIfAborted();
  let result: { status: number; data: unknown };
  if (window.tingyuDesktop) result = await window.tingyuDesktop.requestSource(request);
  else {
    const config = await loadSourceConfig();
    if (request.method === 'POST' && !config.token) throw new Error('上传需要填写写入密钥；留空只能听歌。');
    const url = new URL(request.path.slice(1), normalizeSourceUrl(config.baseUrl)).href;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }; if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const options = { url, headers, connectTimeout: 15000, readTimeout: 120000, responseType: 'json' as const, disableRedirects: true };
    if (Capacitor.getPlatform() === 'android') result = request.method === 'GET' ? await CapacitorHttp.get(options) : await CapacitorHttp.post({ ...options, data: request.body || {} });
    else {
      const response = await fetch(url, { method: request.method, headers: options.headers, body: request.method === 'POST' ? JSON.stringify(request.body || {}) : undefined, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
      result = { status: response.status, data: await response.json() };
    }
  }
  signal?.throwIfAborted();
  if (result.status < 200 || result.status >= 300) {
    const messages: Record<number, string> = { 401: '曲库访问密钥无效或已撤销。', 403: '此密钥只有读取权限，不能上传。', 409: '线上版本或传输检查点已变化，请刷新列表后重新确认。', 413: '请求内容过大。', 422: '音频 SHA-256 校验失败，未覆盖线上歌曲。', 507: '服务器剩余空间不足。' };
    throw Object.assign(new Error(messages[result.status] || `在线曲库请求失败（HTTP ${result.status}）。`), { status: result.status });
  }
  return result.data as Result;
};
const hex = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
const encoded = (bytes: Uint8Array) => { let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(text); };

export function validateSourceTrack(record: SourceTrack): SourceTrack {
  const value = record?.metadata;
  if (!value || !/^[a-f0-9]{64}$/.test(value.id) || ['title', 'artist', 'album', 'format'].some((key) => typeof value[key as keyof typeof value] !== 'string') || !Number.isFinite(value.duration) || !Array.isArray(value.lyrics) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('线上歌曲信息格式无效。');
  for (const line of value.lyrics) if (!line || typeof line.text !== 'string' || !Number.isFinite(line.time) || (line.translation !== undefined && typeof line.translation !== 'string')) throw new Error('线上歌词格式无效。');
  for (const media of [record.audio, record.cover].filter(Boolean) as SourceMedia[]) if (!media || !Number.isSafeInteger(media.size) || media.size <= 0 || typeof media.type !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)) throw new Error('线上文件描述无效。');
  if (!record.audio || record.audio.sha256 !== value.id) throw new Error('线上音频指纹不符。');
  return record;
}
export async function listSource(request: SourceRequester = sourceRequest, signal?: AbortSignal): Promise<SourceTrack[]> {
  const result = new Map<string, SourceTrack>(); let offset: number | null = 0;
  while (offset !== null) {
    const page: { tracks: SourceTrack[]; next: number | null } = await request({ method: 'GET', path: `/tracks?offset=${offset}` }, signal);
    if (!Array.isArray(page.tracks) || page.next !== null && (!Number.isSafeInteger(page.next) || page.next <= offset)) throw new Error('线上曲库分页无效。');
    for (const record of page.tracks) result.set(validateSourceTrack(record).metadata.id, record);
    offset = page.next;
  }
  return [...result.values()];
}
export async function uploadSourceTrack(track: Track, revision: number, config: SourceConfig, onProgress: (message: string) => void, signal: AbortSignal, request: SourceRequester = sourceRequest) {
  const metadata = { id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, format: track.format, lyrics: track.lyrics, lyricsSource: track.lyricsSource, translationSource: track.translationSource, onlineUpdatedAt: track.onlineUpdatedAt, translationAudit: track.translationAudit, favorite: track.favorite, addedAt: track.addedAt };
  const media: Partial<Record<'audio' | 'cover', SourceMedia>> = {};
  for (const kind of ['audio', 'cover'] as const) if (track[kind]) {
    const blob = track[kind]!; const digest = sha256.create();
    onProgress(`校验 ${track.title} · ${kind === 'audio' ? '音频' : '封面'}`);
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) { signal.throwIfAborted(); digest.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer())); }
    media[kind] = { size: blob.size, type: blob.type || (kind === 'audio' ? 'audio/mpeg' : 'image/jpeg'), sha256: hex(digest.digest()) };
  }
  if (media.audio?.sha256 !== track.id) throw new Error('本地歌曲与内容指纹不符，未上传。');
  const body = { metadata, ...media, expectedRevision: revision };
  const fingerprint = hex(sha256(new TextEncoder().encode(JSON.stringify(body))));
  const key = `xianqiji-source-upload:${hex(sha256(new TextEncoder().encode(`${normalizeSourceUrl(config.baseUrl)}|${config.token}`)))}:${track.id}:${fingerprint}`;
  let task: { id: string; offsets: Record<string, number>; done?: boolean } | undefined;
  const saved = localStorage.getItem(key);
  if (saved && /^[a-f0-9]{32}$/.test(saved)) {
    try { task = await request({ method: 'GET', path: `/uploads/${saved}` }, signal); }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; localStorage.removeItem(key); }
  }
  if (!task) {
    const started = await request<{ id: string; offsets: Record<string, number>; done?: boolean } | { existing: SourceTrack }>({ method: 'POST', path: '/uploads', body }, signal);
    if ('existing' in started) {
      const record = validateSourceTrack(started.existing);
      if (record.metadata.id !== track.id || record.audio.sha256 !== media.audio.sha256 || record.audio.size !== track.audio.size) throw new Error('服务器返回的已有音频与本地不符。');
      onProgress(`音频已存在，上传成功 · ${record.metadata.title}`);
      return record;
    }
    task = started;
    if (!/^[a-f0-9]{32}$/.test(task.id)) throw new Error('线上传输任务格式错误。');
    localStorage.setItem(key, task.id);
  }
  for (const kind of ['audio', 'cover'] as const) if (track[kind] && !task.done) {
    const blob = track[kind]!; let offset = task.offsets[kind];
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > blob.size) throw new Error('线上传输检查点无效。');
    while (offset < blob.size) {
      signal.throwIfAborted(); onProgress(`上传 ${track.title} · ${Math.floor(offset / blob.size * 100)}%`);
      const bytes = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
      const next: { offset: number } = await request({ method: 'POST', path: `/uploads/${task.id}/chunk`, body: { kind, offset, data: encoded(bytes) } }, signal);
      if (next.offset !== offset + bytes.length) throw new Error('服务器确认的上传位置不符。'); offset = next.offset;
    }
  }
  const record = validateSourceTrack(await request<SourceTrack>({ method: 'POST', path: `/uploads/${task.id}/finish` }, signal));
  if (record.metadata.id !== track.id || record.audio.sha256 !== media.audio.sha256 || record.revision !== revision + 1) throw new Error('服务器确认的歌曲或修订号不符，请刷新核对。');
  localStorage.removeItem(key); return record;
}
export function supplementSourceMetadata(local: Track, remote: SourceTrack['metadata']): Track {
  const remoteLines = new Map(remote.lyrics.map((line) => [`${Math.round(line.time * 100)}|${line.text.trim()}`, line]));
  const lyrics = local.lyrics.length ? local.lyrics.map((line) => {
    const other = remoteLines.get(`${Math.round(line.time * 100)}|${line.text.trim()}`);
    return { ...line, ...(!timedWords(line) && other && timedWords(other) ? { words: other.words, ...wordTimingMetadata(other) } : {}), translation: line.translation || other?.translation };
  }) : remote.lyrics;
  return { ...local, lyrics, lyricsSource: local.lyrics.length ? local.lyricsSource : remote.lyricsSource, translationSource: local.translationSource || remote.translationSource, translationAudit: local.translationAudit || (!local.lyrics.length ? remote.translationAudit : undefined) };
}
export async function downloadSourceTrack(record: SourceTrack, onProgress: (message: string) => void, signal: AbortSignal, request: SourceRequester = sourceRequest) {
  validateSourceTrack(record);
  const local = await getTrack(record.metadata.id);
  if (!local) return saveStreamedTrack({ ...record.metadata, favorite: !!record.metadata.favorite, addedAt: Date.now() }, record, async (kind, offset, length) => {
    const media = record[kind]!;
    onProgress(`保存到本地音乐库 · ${record.metadata.title} · ${Math.floor(offset / media.size * 100)}%`);
    const chunk = await request<{ data: string; sha256: string; size: number; offset: number }>({ method: 'GET', path: `/tracks/${record.metadata.id}/media/${kind}?offset=${offset}&length=${length}` }, signal);
    if (chunk.sha256 !== media.sha256 || chunk.size !== media.size || chunk.offset !== offset) throw new Error('云端文件版本已变化，未写入音乐库。');
    return Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
  }, signal);
  const read = async (kind: 'audio' | 'cover', media: SourceMedia) => {
    const parts: BlobPart[] = []; const digest = sha256.create();
    for (let offset = 0; offset < media.size; offset += 1024 * 1024) {
      signal.throwIfAborted(); onProgress(`下载 ${record.metadata.title} · ${Math.floor(offset / media.size * 100)}%`);
      const chunk: { data: string; sha256: string; size: number; offset: number } = await request({ method: 'GET', path: `/tracks/${record.metadata.id}/media/${kind}?offset=${offset}&length=${Math.min(1024 * 1024, media.size - offset)}` }, signal);
      const bytes = Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
      if (chunk.sha256 !== media.sha256 || chunk.size !== media.size || chunk.offset !== offset || bytes.length !== Math.min(1024 * 1024, media.size - offset)) throw new Error('线上下载内容或版本已改变，原本地歌曲保留。');
      digest.update(bytes); parts.push(bytes);
    }
    if (hex(digest.digest()) !== media.sha256) throw new Error('下载 SHA-256 不符，未保存损坏文件。');
    return new Blob(parts, { type: media.type });
  };
  const audio = local?.audio || await read('audio', record.audio);
  const cover = local?.cover || (record.cover ? await read('cover', record.cover) : undefined);
  const track = local ? { ...supplementSourceMetadata(local, record.metadata), cover } : { ...record.metadata, audio, cover, favorite: !!record.metadata.favorite, addedAt: Date.now() };
  signal.throwIfAborted(); await saveTracks([track]); return track;
}
