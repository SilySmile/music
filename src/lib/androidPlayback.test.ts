import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';
const plugin = vi.hoisted(() => ({ cached: vi.fn(async () => ({ ids: [] as string[] })), write: vi.fn(async () => {}), finish: vi.fn(async () => {}), state: vi.fn(async () => ({ active: true, id: 'a'.repeat(64), position: 1 })), addListener: vi.fn(async () => ({ remove: vi.fn() })) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => plugin }));
import { androidQueueOptions, isAndroidPlayer, observeAndroidPlayback, prepareAndroidQueue, savedAndroidPosition } from './androidPlayback';
const track: Track = { id: 'a'.repeat(64), title: 'Fixture', artist: 'Demo', album: 'Test', duration: 2, format: 'wav', audio: new Blob([new Uint8Array([1, 2, 3, 4])]), lyrics: [], favorite: false, addedAt: 1 };
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe('Android foreground playback preparation', () => {
  it('copies and validates uncached audio, skips already prepared songs', async () => {
    expect(isAndroidPlayer()).toBe(true);
    await prepareAndroidQueue([track], () => {}, new AbortController().signal);
    expect(plugin.write).toHaveBeenCalledWith({ id: track.id, offset: 0, data: btoa(String.fromCharCode(1, 2, 3, 4)) });
    expect(plugin.finish).toHaveBeenCalledWith({ id: track.id, size: 4 });
    plugin.cached.mockResolvedValueOnce({ ids: [track.id] }); plugin.write.mockClear();
    await prepareAndroidQueue([track], () => {}, new AbortController().signal); expect(plugin.write).not.toHaveBeenCalled();
  });
  it('honors cancellation and never constructs a service queue with audio blobs or service keys', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareAndroidQueue([track], () => {}, controller.signal)).rejects.toThrow(); expect(plugin.write).not.toHaveBeenCalled();
    const options = androidQueueOptions([track], track.id, 12, true, 'shuffle', 0.5, 500, { deadline: 1700000000000, behavior: 'finish-track' });
    expect(options.finishTrack).toBe(true); expect(options.deadline).toBe(1700000000000); expect(options.position).toBe(12);
    expect(options.tracks[0]).not.toHaveProperty('audio'); expect(options.tracks[0]).not.toHaveProperty('lyrics');
  });
  it('plays folder-library songs straight from their document URI without copying', async () => {
    const local = { ...track, contentUri: 'content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2Fsong.mp3' };
    await prepareAndroidQueue([local], () => {}, new AbortController().signal);
    expect(plugin.write).not.toHaveBeenCalled(); expect(plugin.finish).not.toHaveBeenCalled();
    expect(androidQueueOptions([local], local.id, 0, true, 'list', 1, 0, null).tracks[0].contentUri).toBe(local.contentUri);
  });
  it('streams cloud queue entries without preparing or downloading unheard audio', async () => {
    const streamUrl = `https://example.com/music-library/tracks/${track.id}/stream/audio`;
    const cloud = { ...track, cloud: { source: 'https://example.com/music-library/', streamUrl, publicRead: true, record: {} as NonNullable<Track['cloud']>['record'] } };
    const read = vi.spyOn(cloud.audio, 'slice');
    await prepareAndroidQueue([cloud], () => {}, new AbortController().signal);
    expect(plugin.write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(androidQueueOptions([cloud], cloud.id, 0, true, 'list', 1, 0, null).tracks[0].sourceUrl).toBe(streamUrl);
    read.mockRestore();
  });
});

describe('Android playback recovery', () => {
  it('restores the native checkpoint only for an existing song in the same library', () => {
    const saved = { scope: 'folder:phone', id: track.id, position: 1.25 };
    expect(savedAndroidPosition(saved, saved.scope, [track])).toEqual({ id: track.id, position: 1.25 });
    expect(savedAndroidPosition(saved, 'folder:other', [track])).toBeUndefined();
    expect(savedAndroidPosition(saved, saved.scope, [])).toBeUndefined();
    for (const position of [-1, NaN, Infinity]) expect(savedAndroidPosition({ ...saved, position }, saved.scope, [track])).toBeUndefined();
    expect(savedAndroidPosition({ ...saved, position: 100 }, saved.scope, [track])?.position).toBe(track.duration);
    expect(androidQueueOptions([track], track.id, 1.25, true, 'list', 1, 0, null, saved.scope).libraryScope).toBe(saved.scope);
  });

  it('reads the service clock after missed background broadcasts and stops polling on disposal', async () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { hidden: false });
    const receive = vi.fn();
    const stop = observeAndroidPlayback(receive, page);
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ position: 1 }));
    page.hidden = true;
    plugin.state.mockResolvedValue({ active: true, id: track.id, position: 80 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(plugin.state).toHaveBeenCalledTimes(1);
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ position: 80 }));
    plugin.state.mockResolvedValue({ active: true, id: track.id, position: 81 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ position: 81 }));
    stop();
    const delivered = receive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    page.dispatchEvent(new Event('visibilitychange'));
    expect(receive).toHaveBeenCalledTimes(delivered);
  });

  it('ignores a service response that arrives after disposal', async () => {
    vi.useFakeTimers();
    let finish!: (value: { active: boolean; id: string; position: number }) => void;
    plugin.state.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const receive = vi.fn();
    const stop = observeAndroidPlayback(receive, Object.assign(new EventTarget(), { hidden: false }));
    stop();
    finish({ active: true, id: track.id, position: 92 });
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).not.toHaveBeenCalled();
  });
});
