import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';
const fixture = vi.hoisted(() => ({ scope: 'folder:chosen-library', config: { baseUrl: 'https://fixture.test/library/', token: 'private-fixture-write-token', remember: false }, save: vi.fn(), download: vi.fn(), upload: vi.fn(), list: vi.fn(), request: vi.fn(), getTrack: vi.fn() }));
vi.mock('./storage', () => ({ sourceLibraryScope: async () => fixture.scope, saveTransfer: fixture.save, getTrack: fixture.getTrack }));
vi.mock('./onlineSource', () => ({ normalizeSourceUrl: (url: string) => url, loadSourceConfig: async () => fixture.config, downloadSourceTrack: fixture.download, uploadSourceTrack: fixture.upload, listSource: fixture.list, sourceRequest: fixture.request }));
import { createSourceTransfer, runSourceTransfer } from './sourceTransfers';
import { resumeBackgroundTasks } from './backgroundTasks';
const first = 'a'.repeat(64); const second = 'b'.repeat(64);
const song = (id: string): Track => ({ id, title: id.slice(0, 1), artist: 'Fixture', album: 'Test', format: 'WAV', duration: 1, audio: new Blob(['fixture']), addedAt: 1, lyrics: [], favorite: false });
beforeEach(() => {
  vi.clearAllMocks(); resumeBackgroundTasks(); fixture.scope = 'folder:chosen-library'; fixture.config.token = 'private-fixture-write-token';
  fixture.save.mockResolvedValue(undefined); fixture.list.mockResolvedValue([first, second].map((id) => ({ metadata: song(id) })));
  fixture.download.mockImplementation(async (record) => song(record.metadata.id)); fixture.getTrack.mockImplementation(async (id) => song(id)); fixture.upload.mockResolvedValue({});
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
describe('resumable source transfers', () => {
  it('persists ids and identity hashes, never source keys or audio blobs', async () => {
    const task = await createSourceTransfer('download', [first, first, second], fixture.config);
    expect(task.ids).toEqual([first, second]); expect(task.sourceIdentity).toHaveLength(64);
    expect(JSON.stringify(task)).not.toContain(fixture.config.token);
    expect(task.scope).toBe(fixture.scope);
  });
  it('retains completed songs on pause and skips them after task recovery', async () => {
    const task = await createSourceTransfer('download', [first, second], fixture.config);
    const controller = new AbortController();
    await runSourceTransfer(task, controller.signal, vi.fn(), async () => { controller.abort(); });
    expect(task.status).toBe('paused'); expect(task.completed).toEqual([first]);
    await runSourceTransfer(task, new AbortController().signal, vi.fn());
    expect(task.status).toBe('completed'); expect(task.completed).toEqual([first, second]);
    expect(fixture.download.mock.calls.map(([record]) => record.metadata.id)).toEqual([first, second]);
  });
  it('refuses a changed library or connection before downloading or writing anything', async () => {
    const task = await createSourceTransfer('download', [first], fixture.config);
    fixture.scope = 'folder:other-library';
    await runSourceTransfer(task, new AbortController().signal, vi.fn());
    expect(task.status).toBe('failed'); expect(task.error).toContain('另一音乐库');
    fixture.scope = task.scope; fixture.config.token = 'changed-token';
    await runSourceTransfer(task, new AbortController().signal, vi.fn());
    expect(task.error).toContain('地址或密钥'); expect(fixture.download).not.toHaveBeenCalled(); expect(fixture.list).not.toHaveBeenCalled();
  });
  it('does not mark failed media complete and retries only the missing song', async () => {
    const task = await createSourceTransfer('download', [first, second], fixture.config);
    fixture.download.mockImplementationOnce(async () => song(first)).mockRejectedValueOnce(new Error('SHA-256 mismatch'));
    await runSourceTransfer(task, new AbortController().signal, vi.fn());
    expect(task.status).toBe('failed'); expect(task.completed).toEqual([first]);
    await runSourceTransfer(task, new AbortController().signal, vi.fn());
    expect(task.status).toBe('completed'); expect(fixture.download).toHaveBeenCalledTimes(3);
  });
});
