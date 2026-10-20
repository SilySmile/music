import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import type { StoredTrack } from '../types';

const library = vi.hoisted(() => ({ info: { storageMode: 'folder', libraryId: 'library-fixture', uri: 'content://fixture', trackCount: 1, path: '/fixture', previousPath: '', internalPath: '/fixture', legacyMigrated: true, moving: false } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => ({ info: async () => library.info }) }));
vi.mock('./nativeSourceDownloads', () => ({ nativeSourceDownloads: {}, nativeSourceEnabled: () => false, validNativeSourceTask: () => false }));
vi.mock('./backgroundTasks', () => ({ syncNativeBackgroundTask: () => {}, beginBackgroundTask: async () => ({ progress() {}, finish: async () => {}, signal: new AbortController().signal }), dismissBackgroundTask: () => {}, restoreBackgroundTasks: () => {}, useBackgroundTasks: () => [] }));
import { loadTrackSnapshot } from './storage';

const record: StoredTrack = {
  metadata: { id: 'a'.repeat(64), title: 'Fixture', artist: 'Demo', album: 'Test', duration: 2, format: 'mp3', lyrics: [{ time: 0, text: 'line' }], favorite: false, addedAt: 7 },
  audio: { file: 'Demo - Fixture.mp3', size: 1024, type: 'audio/mpeg', sha256: 'a'.repeat(64), uri: 'content://fixture/song.mp3' },
};

async function seed(libraryKey: string, cover?: Blob) {
  const database = await openDB('tingyu-library-snapshot', 1, { upgrade(value) { if (!value.objectStoreNames.contains('snapshot')) value.createObjectStore('snapshot'); } });
  await database.clear('snapshot');
  await database.put('snapshot', { libraryKey, rows: [{ record, cover }] }, 'current');
}

describe('phone library snapshot', () => {
  beforeAll(() => { vi.stubGlobal('window', { location: { origin: 'https://localhost' } }); });
  beforeEach(() => { vi.clearAllMocks(); });
  it('rebuilds the last library without touching the folder', async () => {
    await seed('library-fixture');
    const tracks = await loadTrackSnapshot();
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0].id).toBe(record.metadata.id);
    expect(tracks?.[0].title).toBe('Fixture');
    expect(tracks?.[0].audio.size).toBe(1024);
    expect(tracks?.[0].contentUri).toBe('content://fixture/song.mp3');
  });
  it('ignores a snapshot that belongs to another library', async () => {
    await seed('another-library');
    expect(await loadTrackSnapshot()).toBeUndefined();
  });
  it('keeps the cached cover for instant painting', async () => {
    await seed('library-fixture', new Blob(['cover'], { type: 'image/jpeg' }));
    const tracks = await loadTrackSnapshot();
    expect(tracks?.[0].cover?.size).toBe(5);
  });
});
