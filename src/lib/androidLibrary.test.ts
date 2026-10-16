import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { createHash } from 'node:crypto';
import type { Track } from '../types';
const plugin = vi.hoisted(() => ({ info: vi.fn(), create: vi.fn(), activate: vi.fn(), list: vi.fn(), begin: vi.fn(), write: vi.fn(), finish: vi.fn(), cancel: vi.fn(), cache: vi.fn(), read: vi.fn(), patch: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android', convertFileSrc: (uri: string) => `https://localhost/_capacitor_content_/${uri.slice('content://'.length)}` }, registerPlugin: () => plugin }));
const bytes = new Uint8Array([1, 2, 3, 4, 5]);
const track: Track = { id: createHash('sha256').update(bytes).digest('hex'), title: 'Music', artist: 'Demo', album: '', duration: 1, format: 'wav', audio: new Blob([bytes], { type: 'audio/wav' }), lyrics: [{ time: 0, text: 'Light', translation: '光' }], favorite: true, addedAt: 1 };
const record = () => { const { audio, ...metadata } = track; return { metadata, audio: { file: 'Music.wav', size: audio.size, type: audio.type, sha256: track.id, uri: 'content://library/song/Music.wav' } }; };
const selection = { token: 'selected-folder', path: '/storage/emulated/0/Music/弦栖霁音乐库', uri: 'content://library/tree', trackCount: 0 };
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { origin: 'https://localhost' } }));
  plugin.info.mockResolvedValue({ storageMode: 'database', legacyMigrated: true });
  plugin.begin.mockResolvedValue({ token: 'upload' }); plugin.cache.mockResolvedValue({ entries: [] });
  plugin.cancel.mockResolvedValue({});
  const database = await openDB('tingyu-library', 3, { upgrade(database) { database.createObjectStore('tracks', { keyPath: 'id' }); database.createObjectStore('translations'); database.createObjectStore('transfers', { keyPath: 'id' }); } }); database.close();
});
afterEach(async () => { const database = await openDB('tingyu-library', 3); if (database.objectStoreNames.contains('tracks')) { await database.clear('tracks'); await database.clear('translations'); await database.clear('transfers'); } database.close(); vi.unstubAllGlobals(); });
describe('Android user-selected music library', () => {
  it('copies metadata, original/Chinese lyrics, exact media and translation cache before activation', async () => {
    const { copyAndroidLibrary } = await import('./androidLibrary');
    await copyAndroidLibrary(selection, [track], [['cache-key', '中文缓存']], vi.fn());
    expect(plugin.begin.mock.calls[0][0].metadata.lyrics[0].translation).toBe('光');
    expect(plugin.write).toHaveBeenCalledWith({ token: 'upload', kind: 'audio', offset: 0, data: btoa(String.fromCharCode(...bytes)) });
    expect(plugin.finish).toHaveBeenCalledWith({ token: 'upload', hashes: { audio: track.id } });
    expect(plugin.cache).toHaveBeenCalledWith({ target: selection.token, entries: [['cache-key', '中文缓存']] });
    expect(plugin.activate).toHaveBeenCalledWith({ target: selection.token, expectedIds: [track.id] });
    expect(plugin.activate.mock.invocationCallOrder[0]).toBeGreaterThan(plugin.finish.mock.invocationCallOrder[0]);
  });
  it('does not activate or clear the source after a copy/hash error', async () => {
    plugin.finish.mockRejectedValueOnce(new Error('SHA-256 mismatch'));
    const { copyAndroidLibrary } = await import('./androidLibrary');
    await expect(copyAndroidLibrary(selection, [track], [], vi.fn())).rejects.toThrow('SHA-256');
    expect(plugin.cancel).toHaveBeenCalledWith({ token: 'upload' }); expect(plugin.activate).not.toHaveBeenCalled();
  });
  it('opens a configured folder without reading, copying or merging old IndexedDB audio', async () => {
    const storage = await import('./storage');
    await storage.saveTracks([{ ...track, id: 'old-private-song' }]);
    await storage.cacheTranslation('old-cache', '旧库缓存');
    vi.resetModules();
    plugin.info.mockResolvedValue({ storageMode: 'folder', legacyMigrated: true });
    plugin.list.mockResolvedValue({ tracks: [record()] });
    const folder = await import('./storage');
    const tracks = await folder.getTracks();
    expect(tracks.map((item) => item.id)).toEqual([track.id]);
    expect(plugin.read).not.toHaveBeenCalled(); expect(plugin.begin).not.toHaveBeenCalled();
    const { nativeAudioUrl } = await import('./nativeAudio');
    expect(nativeAudioUrl(tracks[0].audio)).toBe(`https://localhost/__xianqiji_library__/${track.id}`);
    const database = await openDB('tingyu-library', 3);
    expect(await database.count('tracks')).toBe(1); expect(await database.get('translations', 'old-cache')).toBe('旧库缓存'); database.close();
    plugin.read.mockResolvedValue({ data: btoa(String.fromCharCode(2, 3)) });
    expect([...new Uint8Array(await tracks[0].audio.slice(1, 3).arrayBuffer())]).toEqual([2, 3]);
    expect(plugin.read).toHaveBeenCalledWith({ target: undefined, id: track.id, kind: 'audio', offset: 1, length: 2 });
  });
  it('does not silently fall back to an empty/internal library when a configured folder loses permission', async () => {
    plugin.info.mockResolvedValue({ storageMode: 'folder', error: '目录授权失效', legacyMigrated: true });
    const storage = await import('./storage');
    await expect(storage.getTracks()).rejects.toThrow('目录授权失效');
    expect(plugin.list).not.toHaveBeenCalled();
  });
  it('continues to persist the internal database until a folder is explicitly selected', async () => {
    const storage = await import('./storage');
    await storage.saveTracks([track]); await storage.cacheTranslation('translation', '译文');
    expect((await storage.getTracks())[0].lyrics[0].translation).toBe('光');
    expect(await storage.getAndroidTranslationEntries()).toEqual([['translation', '译文']]);
    expect(plugin.create).not.toHaveBeenCalled(); expect(plugin.begin).not.toHaveBeenCalled();
  });
  it('keeps resumable transfer tasks bound to their originating library', async () => {
    const internal = await import('./storage');
    const task = { id: 'old-task', kind: 'import' as const, label: 'Source', fingerprint: 'source', completed: ['song.wav'], total: 2, status: 'paused' as const, updatedAt: 1, warnings: [] };
    await internal.saveTransfer(task);
    expect((await internal.getTransfers()).map((item) => item.id)).toEqual(['old-task']);
    vi.resetModules(); plugin.info.mockResolvedValue({ storageMode: 'folder', legacyMigrated: true, libraryId: 'new-folder' });
    const folder = await import('./storage');
    expect(await folder.getTransfers()).toEqual([]);
    await expect(folder.saveTransfer(task)).rejects.toThrow('另一音乐库');
    vi.resetModules(); plugin.info.mockResolvedValue({ storageMode: 'database', legacyMigrated: true });
    const restored = await import('./storage');
    const restoredTask = (await restored.getTransfers())[0];
    expect(restoredTask.kind === 'import' && restoredTask.completed).toEqual(['song.wav']);
  });
});
