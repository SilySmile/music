import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { sha256 } from '@noble/hashes/sha2.js';
import type { LibraryInfo, LibraryProgress, StoredTrack, Track } from '../types';

export type AndroidLibraryInfo = LibraryInfo & { storageMode: 'database' | 'folder'; uri: string; databaseName: string; libraryId?: string };
export type LibrarySelection = { token: string; path: string; uri: string; trackCount: number };
interface LibraryPlugin {
  info(): Promise<AndroidLibraryInfo>;
  choose(options: { mode: 'copy' | 'existing' }): Promise<LibrarySelection | { cancelled: true }>;
  create(options: { target: string }): Promise<void>;
  activate(options: { target: string; expectedIds?: string[] }): Promise<AndroidLibraryInfo>;
  useDatabase(): Promise<AndroidLibraryInfo>;
  list(options: { target?: string }): Promise<{ tracks: StoredTrack[] }>;
  begin(options: { target?: string; metadata: Omit<Track, 'audio' | 'cover'>; audio: { size: number; type: string }; cover?: { size: number; type: string } }): Promise<{ token: string }>;
  write(options: { token: string; kind: string; offset: number; data: string }): Promise<void>;
  finish(options: { token: string; hashes: Partial<Record<'audio' | 'cover', string>> }): Promise<StoredTrack>;
  cancel(options: { token: string }): Promise<void>;
  read(options: { target?: string; id: string; kind: string; offset: number; length: number }): Promise<{ data: string }>;
  patch(options: { id: string; patch: Partial<Omit<Track, 'id' | 'audio' | 'cover'>> }): Promise<StoredTrack>;
  remove(options: { id: string }): Promise<void>;
  cache(options: { target?: string; entries?: [string, string][] }): Promise<{ entries: [string, string][] }>;
  addListener(event: 'progress', listener: (progress: LibraryProgress) => void): Promise<PluginListenerHandle>;
}
export const androidLibrary = registerPlugin<LibraryPlugin>('DocumentLibrary');
export const isAndroidLibrary = () => Capacitor.getPlatform() === 'android';

export function androidLibraryBridge(target?: string) {
  return {
    streamingAudio: true,
    libraryAudioUrl: (record: StoredTrack) => `${window.location.origin}/__xianqiji_library__/${encodeURIComponent(record.metadata.id)}`,
    getLibraryInfo: () => androidLibrary.info(),
    listLibraryTracks: async () => (await androidLibrary.list({ target })).tracks,
    beginLibraryTrack: async (metadata: Omit<Track, 'audio' | 'cover'>, audio: { size: number; type: string }, cover?: { size: number; type: string }) => (await androidLibrary.begin({ target, metadata, audio, cover })).token,
    writeLibraryChunk: async (token: string, kind: 'audio' | 'cover', offset: number, bytes: Uint8Array) => {
      let binary = '';
      for (let position = 0; position < bytes.length; position += 8192) binary += String.fromCharCode(...bytes.subarray(position, position + 8192));
      await androidLibrary.write({ token, kind, offset, data: btoa(binary) });
    },
    finishLibraryTrack: (token: string, hashes: Partial<Record<'audio' | 'cover', string>>) => androidLibrary.finish({ token, hashes }),
    cancelLibraryTrack: (token: string) => androidLibrary.cancel({ token }),
    readLibraryChunk: async (id: string, kind: 'audio' | 'cover', offset: number, length: number) => {
      const { data } = await androidLibrary.read({ target, id, kind, offset, length });
      return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    },
    patchLibraryTrack: (id: string, patch: Partial<Omit<Track, 'id' | 'audio' | 'cover'>>) => androidLibrary.patch({ id, patch }),
    removeLibraryTrack: (id: string) => androidLibrary.remove({ id }),
    getLibraryCache: async (key: string) => (await androidLibrary.cache({ target })).entries.find(([entry]) => entry === key)?.[1],
    setLibraryCache: async (entries: [string, string][]) => { await androidLibrary.cache({ target, entries }); },
    finishLibraryMigration: async () => {},
  };
}

export async function copyAndroidLibrary(selection: LibrarySelection, tracks: Track[], cache: [string, string][], onProgress: (progress: LibraryProgress) => void) {
  await androidLibrary.create({ target: selection.token });
  const destination = androidLibraryBridge(selection.token);
  for (const [index, track] of tracks.entries()) {
    onProgress({ stage: `复制歌曲 · ${track.title}`, completed: index, total: tracks.length });
    const { audio, cover, ...metadata } = track;
    const token = await destination.beginLibraryTrack(metadata, { size: audio.size, type: audio.type }, cover && { size: cover.size, type: cover.type });
    try {
      const hashes: Partial<Record<'audio' | 'cover', string>> = {};
      for (const kind of ['audio', 'cover'] as const) {
        const media = track[kind];
        if (!media) continue;
        const digest = sha256.create();
        for (let offset = 0; offset < media.size; offset += 1024 * 1024) {
          const bytes = new Uint8Array(await media.slice(offset, offset + 1024 * 1024).arrayBuffer());
          digest.update(bytes);
          await destination.writeLibraryChunk(token, kind, offset, bytes);
        }
        hashes[kind] = Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
      }
      await destination.finishLibraryTrack(token, hashes);
    } catch (error) { await destination.cancelLibraryTrack(token).catch(() => {}); throw error; }
  }
  await destination.setLibraryCache(cache);
  onProgress({ stage: '复制完成，正在核验曲库', completed: tracks.length, total: tracks.length });
  return androidLibrary.activate({ target: selection.token, expectedIds: tracks.map((track) => track.id) });
}
