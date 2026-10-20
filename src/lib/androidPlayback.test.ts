import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';
const plugin = vi.hoisted(() => ({ cached: vi.fn(async () => ({ ids: [] as string[] })), write: vi.fn(async () => {}), finish: vi.fn(async () => {}) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => plugin }));
import { androidQueueOptions, isAndroidPlayer, prepareAndroidQueue } from './androidPlayback';
const track: Track = { id: 'a'.repeat(64), title: 'Fixture', artist: 'Demo', album: 'Test', duration: 2, format: 'wav', audio: new Blob([new Uint8Array([1, 2, 3, 4])]), lyrics: [], favorite: false, addedAt: 1 };
afterEach(() => vi.clearAllMocks());
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
