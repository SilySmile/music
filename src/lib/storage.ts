import { openDB } from 'idb';
import { sha256 } from '@noble/hashes/sha2.js';
import type { StoredTrack, Track } from '../types';
import type { ImportTask, TransferTask } from './transferTypes';
import { nativeAudio } from './nativeAudio';
import { androidLibrary, androidLibraryBridge, isAndroidLibrary } from './androidLibrary';
import { nativeSourceDownloads, validNativeSourceTask } from './nativeSourceDownloads';
import { syncNativeBackgroundTask } from './backgroundTasks';

const database = openDB('tingyu-library', 3, {
  upgrade(database) {
    if (!database.objectStoreNames.contains('tracks')) database.createObjectStore('tracks', { keyPath: 'id' });
    if (!database.objectStoreNames.contains('translations')) database.createObjectStore('translations');
    if (!database.objectStoreNames.contains('transfers')) database.createObjectStore('transfers', { keyPath: 'id' });
  },
});

let mobileBridge: ReturnType<typeof androidLibraryBridge> | undefined;
let mobileReady: Promise<void> | undefined;
let mobileLibraryKey = 'database';
const desktop = () => typeof window !== 'undefined' && window.tingyuDesktop?.getLibraryInfo ? window.tingyuDesktop : mobileBridge;
async function ensureBackend() {
  if (!isAndroidLibrary() || window.tingyuDesktop) return;
  if (!mobileReady) mobileReady = androidLibrary.info().then((info) => { if (info.storageMode === 'folder') { if (info.error) throw new Error(info.error); mobileBridge = androidLibraryBridge(); mobileLibraryKey = info.libraryId || info.uri || 'folder'; } }).catch((error) => { mobileReady = undefined; throw error; });
  await mobileReady;
}
const nativeTracks = new Map<string, Track>();
const storedRecords = new Map<string, StoredTrack>();
const snapshotDatabase = openDB('tingyu-library-snapshot', 1, {
  upgrade(database) { if (!database.objectStoreNames.contains('snapshot')) database.createObjectStore('snapshot'); },
});
type TrackSnapshot = { libraryKey: string; rows: { record: StoredTrack; cover?: Blob }[] };
/** Last saved list for the current phone library, so a cold start can paint before walking the folder. */
export async function loadTrackSnapshot(): Promise<Track[] | undefined> {
  if (!isAndroidLibrary() || window.tingyuDesktop) return undefined;
  await ensureBackend();
  const snapshot = await (await snapshotDatabase).get('snapshot', 'current') as TrackSnapshot | undefined;
  if (!snapshot || snapshot.libraryKey !== mobileLibraryKey || !snapshot.rows?.length) return undefined;
  const bridge = androidLibraryBridge();
  const tracks: Track[] = [];
  for (const { record, cover } of snapshot.rows) {
    storedRecords.set(record.metadata.id, record);
    const track: Track = { ...record.metadata, contentUri: record.audio.uri, audio: nativeAudio(record, bridge.readLibraryChunk, bridge.libraryAudioUrl(record)), cover };
    tracks.push(track);
  }
  return tracks.sort((first, second) => second.addedAt - first.addedAt);
}
export async function saveTrackSnapshot(tracks: Track[]) {
  if (!isAndroidLibrary() || window.tingyuDesktop) return;
  const rows = tracks.flatMap((track) => { const record = storedRecords.get(track.id); return record ? [{ record, cover: track.cover }] : []; });
  if (!rows.length) return;
  await (await snapshotDatabase).put('snapshot', { libraryKey: mobileLibraryKey, rows }, 'current');
}
export function invalidateLibraryTracks(ids: string[]) { for (const id of ids) nativeTracks.delete(id); }
const chunkSize = 4 * 1024 * 1024;
export async function sourceLibraryScope() {
  await ensureBackend();
  if (isAndroidLibrary() && !window.tingyuDesktop) {
    const info = await androidLibrary.info();
    if (info.error) throw new Error(info.error);
    return info.storageMode === 'folder' ? `folder:${info.libraryId || info.uri}` : 'database';
  }
  const bridge = desktop();
  if (!bridge) return 'database';
  const info = await bridge.getLibraryInfo();
  if (info.error) throw new Error(info.error);
  return `folder:${info.path}`;
}
let nativeReady: Promise<void> | undefined;

async function saveNativeTrack(track: Track) {
  const bridge = desktop()!;
  const { audio, cover, ...metadata } = track;
  const token = await bridge.beginLibraryTrack(metadata, { size: audio.size, type: audio.type }, cover && { size: cover.size, type: cover.type });
  try {
    const hashes: Partial<Record<'audio' | 'cover', string>> = {};
    for (const kind of ['audio', 'cover'] as const) {
      const blob = track[kind];
      if (!blob) continue;
      const hash = sha256.create();
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
        hash.update(bytes);
        await bridge.writeLibraryChunk(token, kind, offset, bytes);
      }
      hashes[kind] = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    await bridge.finishLibraryTrack(token, hashes);
    nativeTracks.set(track.id, track);
  } catch (error) { await bridge.cancelLibraryTrack(token).catch(() => {}); throw error; }
}

async function ensureNative() {
  const bridge = desktop();
  if (!bridge) return;
  if (!nativeReady) nativeReady = (async () => {
    const info = await bridge.getLibraryInfo();
    if (info.error) throw new Error(info.error);
    if (info.legacyMigrated) return;
    const stored = await database;
    const legacy = await stored.getAll('tracks') as Track[];
    const progress = (message: string) => window.dispatchEvent(new CustomEvent('tingyu-storage-progress', { detail: message }));
    try {
      for (const [index, track] of legacy.entries()) {
        progress(`正在安全迁移旧音乐库 ${index + 1} / ${legacy.length} · ${track.title}，请勿退出`);
        await saveNativeTrack(track);
      }
      const keys = await stored.getAllKeys('translations');
      const entries: [string, string][] = [];
      for (const key of keys) { const value = await stored.get('translations', key); if (typeof key === 'string' && typeof value === 'string') entries.push([key, value]); }
      if (entries.length) await bridge.setLibraryCache(entries);
      await bridge.finishLibraryMigration();
      const transaction = stored.transaction(['tracks', 'translations'], 'readwrite');
      await transaction.objectStore('tracks').clear();
      await transaction.objectStore('translations').clear();
      await transaction.done;
    } finally { progress(''); }
  })().catch((error) => { nativeReady = undefined; throw error; });
  await nativeReady;
}

async function hydrate(record: StoredTrack): Promise<Track> {
  storedRecords.set(record.metadata.id, record);
  const existing = nativeTracks.get(record.metadata.id);
  if (existing) { const track = { ...existing, ...record.metadata }; nativeTracks.set(track.id, track); return track; }
  const read = async (kind: 'audio' | 'cover', media: StoredTrack['audio']) => {
    const parts: BlobPart[] = [];
    const hash = sha256.create();
    for (let offset = 0; offset < media.size; offset += chunkSize) { const bytes = new Uint8Array(await desktop()!.readLibraryChunk(record.metadata.id, kind, offset, Math.min(chunkSize, media.size - offset))); hash.update(bytes); parts.push(bytes); }
    const checksum = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (checksum !== media.sha256) throw new Error(`《${record.metadata.title}》的${kind === 'audio' ? '音频' : '封面'}文件已改变或损坏，请恢复备份或重新导入。`);
    return new Blob(parts, { type: media.type });
  };
  const bridge = desktop()!;
  const url = 'libraryAudioUrl' in bridge ? bridge.libraryAudioUrl(record) : undefined;
  const track = { ...record.metadata, contentUri: record.audio.uri, audio: bridge.streamingAudio ? nativeAudio(record, bridge.readLibraryChunk, url) : await read('audio', record.audio), cover: record.cover ? await read('cover', record.cover) : undefined };
  nativeTracks.set(track.id, track);
  return track;
}

export async function getTracks(): Promise<Track[]> {
  await ensureBackend();
  if (desktop()) {
    await ensureNative();
    const records = await desktop()!.listLibraryTracks();
    const progress = (message: string) => window.dispatchEvent(new CustomEvent('tingyu-storage-progress', { detail: message }));
    const result: Track[] = new Array(records.length);
    let cursor = 0; let done = 0;
    try {
      // Reading covers and metadata serially over the bridge dominated start-up time on large
      // libraries; a few workers overlap the bridge round trip with hashing without flooding it.
      const worker = async () => {
        while (cursor < records.length) {
          const index = cursor; cursor += 1;
          const record = records[index];
          if (!nativeTracks.has(record.metadata.id)) progress(`正在读取文件音乐库 ${done + 1} / ${records.length} · ${record.metadata.title}`);
          result[index] = await hydrate(record);
          done += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, records.length) }, worker));
      const sorted = result.sort((first, second) => second.addedAt - first.addedAt);
      void saveTrackSnapshot(sorted).catch(() => {});
      return sorted;
    } finally { progress(''); }
  }
  return (await (await database).getAll('tracks')).sort((first, second) => second.addedAt - first.addedAt);
}

export async function saveTracks(tracks: Track[]) {
  await ensureBackend();
  if (desktop()) { await ensureNative(); for (const track of tracks) await saveNativeTrack(track); return; }
  const transaction = (await database).transaction('tracks', 'readwrite');
  await Promise.all(tracks.map((track) => transaction.store.put(track)));
  await transaction.done;
}

export async function saveStreamedTrack(metadata: Omit<Track, 'audio' | 'cover'>, media: { audio: { size: number; type: string; sha256: string }; cover?: { size: number; type: string; sha256: string } }, reader: (kind: 'audio' | 'cover', offset: number, length: number) => Promise<Uint8Array>, signal: AbortSignal): Promise<Track> {
  await ensureBackend(); signal.throwIfAborted();
  const bridge = desktop();
  if (bridge) await ensureNative();
  const token = bridge ? await bridge.beginLibraryTrack(metadata, media.audio, media.cover) : undefined;
  const blobs: Partial<Record<'audio' | 'cover', Blob>> = {};
  const hashes: Partial<Record<'audio' | 'cover', string>> = {};
  try {
    for (const kind of ['audio', 'cover'] as const) {
      const descriptor = media[kind]; if (!descriptor) continue;
      const hash = sha256.create(); const parts: BlobPart[] = [];
      for (let offset = 0; offset < descriptor.size; offset += 1024 * 1024) {
        signal.throwIfAborted(); const length = Math.min(1024 * 1024, descriptor.size - offset);
        const bytes = await reader(kind, offset, length);
        if (bytes.length !== length) throw new Error('云端歌曲不完整，未加入本地音乐库。');
        hash.update(bytes);
        if (bridge && token) await bridge.writeLibraryChunk(token, kind, offset, bytes); else parts.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      }
      hashes[kind] = Array.from(hash.digest(), (value) => value.toString(16).padStart(2, '0')).join('');
      if (hashes[kind] !== descriptor.sha256) throw new Error('云端歌曲 SHA-256 不符，未加入本地音乐库。');
      if (!bridge) blobs[kind] = new Blob(parts, { type: descriptor.type });
    }
    signal.throwIfAborted();
    if (bridge && token) { const record = await bridge.finishLibraryTrack(token, hashes); return hydrate(record); }
    const track = { ...metadata, audio: blobs.audio!, cover: blobs.cover }; await saveTracks([track]); return track;
  } catch (error) { if (bridge && token) await bridge.cancelLibraryTrack(token).catch(() => {}); throw error; }
}

export async function deleteTrack(id: string) {
  await ensureBackend();
  if (desktop()) { await ensureNative(); await desktop()!.removeLibraryTrack(id); nativeTracks.delete(id); return; }
  await (await database).delete('tracks', id);
}

export async function patchTrack(id: string, patch: Partial<Omit<Track, 'id'>>): Promise<Track> {
  await ensureBackend();
  if (desktop()) {
    await ensureNative();
    const existing = await getTrack(id);
    if (!existing) throw new Error('这首歌曲已被移除。');
    const updated = { ...existing, ...patch, id };
    if (patch.audio || patch.cover) await saveNativeTrack(updated);
    else { const { audio: _audio, cover: _cover, ...metadata } = updated; await desktop()!.patchLibraryTrack(id, metadata); nativeTracks.set(id, updated); }
    return updated;
  }
  const transaction = (await database).transaction('tracks', 'readwrite');
  const existing = await transaction.store.get(id) as Track | undefined;
  if (!existing) throw new Error('这首歌曲已被移除。');
  const updated = { ...existing, ...patch, id };
  await transaction.store.put(updated);
  await transaction.done;
  return updated;
}

export async function getCachedTranslation(key: string): Promise<string | undefined> {
  await ensureBackend();
  if (desktop()) { await ensureNative(); return desktop()!.getLibraryCache(key); }
  return (await database).get('translations', key);
}

export async function cacheTranslation(key: string, value: string) {
  await ensureBackend();
  if (desktop()) { await ensureNative(); await desktop()!.setLibraryCache([[key, value]]); return; }
  await (await database).put('translations', value, key);
}

export async function getTrack(id: string): Promise<Track | undefined> {
  await ensureBackend();
  if (desktop()) { await ensureNative(); if (nativeTracks.has(id)) return nativeTracks.get(id); const record = (await desktop()!.listLibraryTracks()).find((item) => item.metadata.id === id); return record ? hydrate(record) : undefined; }
  return (await database).get('tracks', id);
}
export async function getTransfers(): Promise<TransferTask[]> {
  await ensureBackend();
  const stored = await database;
  if (isAndroidLibrary() && mobileBridge) {
    const states = (await nativeSourceDownloads.sourceTasks()).tasks || [];
    for (const task of states) {
      if (!validNativeSourceTask(task) || task.libraryKey !== mobileLibraryKey || task.scope !== `folder:${mobileLibraryKey}`) continue;
      await stored.put('transfers', task); syncNativeBackgroundTask(task);
    }
  }
  const tasks = await stored.getAll('transfers') as TransferTask[];
  return tasks.filter((task) => !isAndroidLibrary() || (task.libraryKey || 'database') === mobileLibraryKey).sort((first, second) => second.updatedAt - first.updatedAt);
}
export async function saveTransfer(task: TransferTask) {
  await ensureBackend();
  if (isAndroidLibrary()) {
    if (task.libraryKey && task.libraryKey !== mobileLibraryKey) throw new Error('这个传输任务属于另一音乐库，请先切回原库。');
    task.libraryKey = mobileLibraryKey;
  }
  await (await database).put('transfers', task);
}
export async function deleteTransfer(id: string) {
  await ensureBackend(); const stored = await database; const task = await stored.get('transfers', id) as TransferTask | undefined;
  if (isAndroidLibrary() && task?.kind === 'source' && task.nativeDownload) await nativeSourceDownloads.forgetSource({ id });
  await stored.delete('transfers', id);
}

export async function commitImportedTrack(track: Track | undefined, task: ImportTask, entry: string) {
  await ensureBackend();
  if (desktop()) {
    await ensureNative();
    if (track) {
      const existing = await getTrack(track.id);
      if (!existing) await saveNativeTrack(track);
    }
    const completed = [...new Set([...task.completed, entry])];
    await saveTransfer({ ...task, completed, updatedAt: Date.now() });
    task.completed = completed;
    return;
  }
  const transaction = (await database).transaction(['tracks', 'transfers'], 'readwrite');
  if (track) {
    const existing = await transaction.objectStore('tracks').get(track.id) as Track | undefined;
    if (!existing) await transaction.objectStore('tracks').put(track);
  }
  const completed = [...new Set([...task.completed, entry])];
  const next = { ...task, completed, updatedAt: Date.now() };
  await transaction.objectStore('transfers').put(next);
  await transaction.done;
  task.completed = completed;
}

export async function getAndroidTranslationEntries(): Promise<[string, string][]> {
  await ensureBackend();
  if (mobileBridge) return (await androidLibrary.cache({})).entries;
  const stored = await database;
  const transaction = stored.transaction('translations');
  const keys = await transaction.store.getAllKeys();
  const values = await transaction.store.getAll();
  return keys.flatMap((key, index) => typeof key === 'string' && typeof values[index] === 'string' ? [[key, values[index]] as [string, string]] : []);
}
