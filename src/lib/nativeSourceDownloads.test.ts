import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';
const fixture = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), update: vi.fn(), addListener: vi.fn(), pauseSource: vi.fn(), downloadSource: vi.fn(), scope: 'folder:chosen', config: { baseUrl: 'https://fixture.test/library/', token: '', remember: false }, save: vi.fn(), get: vi.fn(), invalidate: vi.fn(), list: vi.fn(), request: vi.fn(), jsDownload: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => fixture }));
vi.mock('./storage', () => ({ sourceLibraryScope: async () => fixture.scope, saveTransfer: fixture.save, getTrack: fixture.get, invalidateLibraryTracks: fixture.invalidate }));
vi.mock('./onlineSource', () => ({ normalizeSourceUrl: (url: string) => url, loadSourceConfig: async () => fixture.config, downloadSourceTrack: fixture.jsDownload, uploadSourceTrack: vi.fn(), listSource: fixture.list, sourceRequest: fixture.request }));
const first = 'a'.repeat(64); const second = 'b'.repeat(64);
const song = (id: string): Track => ({ id, title: id, artist: 'Fixture', album: '', format: 'wav', duration: 1, audio: new Blob(['test']), lyrics: [], favorite: false, addedAt: 1 });
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); fixture.scope = 'folder:chosen';
  fixture.begin.mockResolvedValue(undefined); fixture.finish.mockResolvedValue(undefined); fixture.update.mockResolvedValue(undefined); fixture.pauseSource.mockResolvedValue(undefined);
  fixture.addListener.mockResolvedValue({ remove: vi.fn() }); fixture.save.mockResolvedValue(undefined); fixture.get.mockImplementation(async (id) => song(id));
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
describe('Android native folder download delegation', () => {
  it('hands the entire queue to native once without any JavaScript chunk or song loop', async () => {
    const { createSourceTransfer, runSourceTransfer } = await import('./sourceTransfers');
    const task = await createSourceTransfer('download', [first, second], fixture.config);
    fixture.downloadSource.mockImplementation(async ({ task }) => ({ ...task, nativeDownload: true, status: 'completed', completed: [first, second] }));
    const saved = vi.fn(); await runSourceTransfer(task, new AbortController().signal, vi.fn(), saved);
    expect(fixture.downloadSource).toHaveBeenCalledTimes(1); expect(fixture.downloadSource).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: fixture.config.baseUrl, token: '', task: expect.objectContaining({ ids: [first, second] }) }));
    expect(fixture.jsDownload).not.toHaveBeenCalled(); expect(fixture.list).not.toHaveBeenCalled(); expect(fixture.request).not.toHaveBeenCalled(); expect(saved).toHaveBeenCalledTimes(2); expect(fixture.invalidate).toHaveBeenCalledWith([first, second]); expect(task.status).toBe('completed');
  });
  it('forwards pause to native and keeps native-completed songs for recovery', async () => {
    const { createSourceTransfer, runSourceTransfer } = await import('./sourceTransfers'); const task = await createSourceTransfer('download', [first, second], fixture.config); const controller = new AbortController();
    fixture.downloadSource.mockImplementation(async ({ task }) => { controller.abort(); return { ...task, nativeDownload: true, status: 'paused', completed: [first] }; });
    await runSourceTransfer(task, controller.signal, vi.fn()); expect(fixture.pauseSource).toHaveBeenCalledWith({ id: task.id }); expect(task.status).toBe('paused'); expect(task.completed).toEqual([first]);
  });
  it('refuses mismatched native results without registering another library', async () => {
    const { createSourceTransfer, runSourceTransfer } = await import('./sourceTransfers'); const task = await createSourceTransfer('download', [first], fixture.config);
    fixture.downloadSource.mockImplementation(async ({ task }) => ({ ...task, nativeDownload: true, status: 'completed', completed: [first], scope: 'folder:other' }));
    await runSourceTransfer(task, new AbortController().signal, vi.fn()); expect(task.status).toBe('failed'); expect(task.error).toContain('不符'); expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});
