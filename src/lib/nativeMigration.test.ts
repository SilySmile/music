import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const createLibrary = createRequire(import.meta.url)('../../electron/library.cjs');

it('only clears legacy audio / Chinese / cache after verified migration and restores the moved library after reload', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xianqiji-migration-test-'));
  const userData = path.join(directory, 'profile');
  const library = createLibrary({ userData });
  const database = await openDB('tingyu-library', 3, { upgrade(database) { database.createObjectStore('tracks', { keyPath: 'id' }); database.createObjectStore('translations'); database.createObjectStore('transfers', { keyPath: 'id' }); } });
  const track = { id: 'legacy-a', title: 'Legacy', artist: 'Demo', album: '', duration: 1, format: 'wav', audio: new Blob([new Uint8Array([3, 4, 5])], { type: 'audio/wav' }), lyrics: [{ time: 0, text: 'Soft light', translation: '旧库中的中文' }], favorite: true, addedAt: 1 };
  await database.put('tracks', track); await database.put('translations', '旧缓存译文', 'cache-key');
  const bridge = {
    getLibraryInfo: () => library.info(), listLibraryTracks: () => library.list(), beginLibraryTrack: (...parameters: unknown[]) => library.begin(...parameters), writeLibraryChunk: (...parameters: unknown[]) => library.write(...parameters), finishLibraryTrack: vi.fn().mockRejectedValueOnce(new Error('模拟校验失败')).mockImplementation((...parameters: unknown[]) => library.finish(...parameters)), cancelLibraryTrack: (token: string) => library.cancel(token), readLibraryChunk: (...parameters: unknown[]) => library.read(...parameters), getLibraryCache: (key: string) => library.getCache(key), setLibraryCache: (entries: [string, string][]) => library.setCache(entries), finishLibraryMigration: () => library.markMigrated(), patchLibraryTrack: (...parameters: unknown[]) => library.patch(...parameters),
  };
  const window = Object.assign(new EventTarget(), { tingyuDesktop: bridge });
  vi.stubGlobal('window', window);
  try {
    const storage = await import('./storage');
    await expect(storage.getTracks()).rejects.toThrow('模拟校验失败');
    expect(await database.count('tracks')).toBe(1);
    expect(await database.get('translations', 'cache-key')).toBe('旧缓存译文');
    await library.move(path.join(directory, 'retry-in-new-location'));
    const migrated = await storage.getTracks();
    expect(migrated[0].lyrics[0].translation).toBe('旧库中的中文');
    expect(migrated[0].favorite).toBe(true);
    expect(await database.count('tracks')).toBe(0);
    expect(await database.count('translations')).toBe(0);
    expect(await storage.getCachedTranslation('cache-key')).toBe('旧缓存译文');
    await storage.patchTrack(track.id, { lyrics: [{ time: 0, text: 'Soft light', translation: '新的 AI 中文' }] });
    const task = { id: 'reimport-task', kind: 'import' as const, label: 'Reimport', fingerprint: 'same-audio', completed: [], total: 1, status: 'paused' as const, updatedAt: 1, warnings: [] };
    await storage.commitImportedTrack({ ...track, lyrics: [{ time: 0, text: 'Soft light' }] }, task, 'same.wav');
    expect((await storage.getTrack(track.id))?.lyrics[0].translation).toBe('新的 AI 中文');
    await library.move(path.join(directory, 'new-library'));
    const restored = createLibrary({ userData });
    expect((await restored.list())[0].metadata.lyrics[0].translation).toBe('新的 AI 中文');
    expect(await fs.readFile(path.join((await restored.info()).path, '歌曲', track.id, 'Demo - Legacy.zh.lrc'), 'utf8')).toContain('新的 AI 中文');
  } finally {
    vi.unstubAllGlobals(); database.close();
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^xianqiji-migration-test-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('does not import or clear unrelated legacy IndexedDB data when opening an existing library', async () => {
  vi.resetModules();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xianqiji-migration-test-'));
  const userData = path.join(directory, 'current');
  const targetLibrary = createLibrary({ userData: path.join(directory, 'existing') });
  const bytes = new Uint8Array([7, 8, 9]);
  const metadata = { id: 'existing-only', title: 'Existing', artist: 'Demo', album: '', duration: 1, format: 'wav', favorite: false, addedAt: 1, lyrics: [{ time: 0, text: 'Original', translation: '已有库中文' }] };
  const token = await targetLibrary.begin(metadata, { size: bytes.length, type: 'audio/wav' });
  await targetLibrary.write(token, 'audio', 0, bytes); await targetLibrary.finish(token, { audio: createHash('sha256').update(bytes).digest('hex') });
  await targetLibrary.setCache([['shared', '已有库缓存']]);
  const target = (await targetLibrary.info()).path;
  const before = await fs.readFile(path.join(target, 'library.json'), 'utf8');
  const library = createLibrary({ userData }); await library.useExisting(target);
  const database = await openDB('tingyu-library', 3);
  const legacy = { ...metadata, id: 'unrelated-legacy', audio: new Blob([bytes], { type: 'audio/wav' }) };
  await database.put('tracks', legacy); await database.put('translations', '不相关旧缓存', 'shared');
  const bridge = {
    getLibraryInfo: () => library.info(), listLibraryTracks: () => library.list(), readLibraryChunk: (...parameters: unknown[]) => library.read(...parameters),
    beginLibraryTrack: vi.fn(), setLibraryCache: vi.fn(), finishLibraryMigration: vi.fn(),
  };
  vi.stubGlobal('window', Object.assign(new EventTarget(), { tingyuDesktop: bridge }));
  try {
    const storage = await import('./storage');
    const tracks = await storage.getTracks();
    expect(tracks.map((track) => track.id)).toEqual(['existing-only']);
    expect(tracks[0].lyrics[0].translation).toBe('已有库中文');
    expect(bridge.beginLibraryTrack).not.toHaveBeenCalled();
    expect(bridge.setLibraryCache).not.toHaveBeenCalled();
    expect(bridge.finishLibraryMigration).not.toHaveBeenCalled();
    expect(await database.get('tracks', legacy.id)).toBeDefined();
    expect(await database.get('translations', 'shared')).toBe('不相关旧缓存');
    expect(await library.getCache('shared')).toBe('已有库缓存');
    expect(await fs.readFile(path.join(target, 'library.json'), 'utf8')).toBe(before);
  } finally {
    await database.clear('tracks'); await database.clear('translations'); database.close(); vi.unstubAllGlobals();
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^xianqiji-migration-test-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
