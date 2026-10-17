import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Track } from '../types';
import { planSourceUpload, runSourceAutoSync, sourceSyncKey, sourceSyncTrigger } from './sourceAutoSync';
import type { SourceRequester, SourceTrack, uploadSourceTrack } from './onlineSource';

const config = { baseUrl: 'https://source.example.test/library/', token: 'test-private-owner-token', remember: true, autoSync: true };
function song(text = 'fixture'): Track {
  const bytes = new TextEncoder().encode(text);
  return { id: createHash('sha256').update(bytes).digest('hex'), audio: new Blob([bytes], { type: 'audio/wav' }), title: text, artist: 'Artist', album: 'Album', format: 'wav', duration: 1, lyrics: [{ time: 0, text: 'Light', translation: '光' }], favorite: false, addedAt: 1 };
}
function record(track: Track, revision = 1): SourceTrack {
  const { audio, cover: _cover, ...metadata } = track;
  return { metadata, audio: { size: audio.size, sha256: track.id, type: audio.type }, revision, updatedAt: 1 };
}
function fixture() {
  const remote = new Map<string, SourceTrack>(); let writable = true; let verification = true; let corrupt = false;
  const request = vi.fn(async ({ path }: Parameters<SourceRequester>[0]) => {
    if (path === '/info') return { product: 'xianqiji-online-library', schema: 1, chunkBytes: 1024 * 1024, canWrite: writable, verification };
    if (path.startsWith('/tracks?')) return { tracks: [...remote.values()], next: null };
    if (path.endsWith('/verify')) { const value = remote.get(path.split('/')[2])!; return { id: value.metadata.id, revision: value.revision, ok: !corrupt, media: { audio: !corrupt } }; }
    throw Error(`Unexpected route ${path}`);
  }) as unknown as SourceRequester;
  const upload = vi.fn(async (track: Track, revision: number) => { corrupt = false; const value = record(track, revision + 1); remote.set(track.id, value); return value; }) as unknown as typeof uploadSourceTrack;
  const run = (tracks: Track[], scope = 'library-a', signal = new AbortController().signal) => runSourceAutoSync({ tracks, scope, config, signal, request, upload, progress: vi.fn() });
  return { remote, run, upload, request, readOnly: () => { writable = false; }, oldServer: () => { verification = false; }, corrupt: () => { corrupt = true; } };
}
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) || null, setItem: (key: string, value: string) => entries.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
describe('automatic private source upload', () => {
  it('uploads all current songs once, verifies them online and skips identical content on repeat', async () => {
    const source = fixture(); const tracks = [song('first'), song('second')];
    expect(await source.run(tracks)).toMatchObject({ uploaded: 2, checked: 2, errors: 0, conflicts: 0 });
    expect(await source.run(tracks)).toMatchObject({ uploaded: 0, unchanged: 2 });
    expect(source.upload).toHaveBeenCalledTimes(2);
    expect((source.request as ReturnType<typeof vi.fn>).mock.calls.filter(([request]) => request.path.endsWith('/verify'))).toHaveLength(4);
  });
  it('automatically uploads later saved translations but never treats playback or favorites as new content', async () => {
    const source = fixture(); const track = song();
    await source.run([track]);
    const changed = { ...track, lyrics: [{ ...track.lyrics[0], translation: '修订的中文' }] };
    expect(sourceSyncTrigger([track])).toBe(sourceSyncTrigger([{ ...track, favorite: true, lastPlayed: 99 }]));
    expect(sourceSyncTrigger([changed])).not.toBe(sourceSyncTrigger([track]));
    expect(await source.run([changed])).toMatchObject({ uploaded: 1 });
    expect(source.remote.get(track.id)?.metadata.lyrics[0].translation).toBe('修订的中文');
  });
  it('detects word timing edits, supplements missing word timing and protects conflicts', async () => {
    const track = song();
    const timed = { ...track, lyrics: [{ ...track.lyrics[0], words: [{ time: 0, endTime: .8, text: 'Light' }] }] };
    expect(sourceSyncTrigger([timed])).not.toBe(sourceSyncTrigger([track]));
    expect(planSourceUpload(track, undefined, record(timed)).action).toBe('skip');
    expect(planSourceUpload(timed, undefined, record(track))).toMatchObject({ action: 'upload', track: timed });
    const other = { ...timed, lyrics: [{ ...timed.lyrics[0], words: [{ time: 0, endTime: .5, text: 'Light' }] }] };
    expect(planSourceUpload(timed, undefined, record(other)).action).toBe('conflict');
    const source = fixture(); await source.run([track]);
    expect(await source.run([timed])).toMatchObject({ uploaded: 1 });
    expect(source.remote.get(track.id)?.metadata.lyrics[0].words).toEqual(timed.lyrics[0].words);
  });
  it('protects concurrent edits and first-connection conflicts, retaining both sides', async () => {
    const source = fixture(); const track = song(); await source.run([track]);
    source.remote.set(track.id, record({ ...track, lyrics: [{ ...track.lyrics[0], translation: '另一台设备的中文' }] }, 2));
    expect(await source.run([{ ...track, lyrics: [{ ...track.lyrics[0], translation: '本机新中文' }] }])).toMatchObject({ uploaded: 0, conflicts: 1 });
    expect(source.upload).toHaveBeenCalledTimes(1);
    expect(planSourceUpload(track, undefined, record({ ...track, album: 'Different' })).action).toBe('conflict');
    expect(planSourceUpload(track, 'a'.repeat(64), { ...record(track), cover: { sha256: 'b'.repeat(64), size: 1, type: 'image/jpeg' } }).action).toBe('conflict');
  });
  it('retains estimate labels and singing notes when supplementing missing remote timing', () => {
    const track = song();
    const estimated: Track = { ...track, lyrics: [{ ...track.lyrics[0], words: [{ time: 0, endTime: .8, text: 'Light' }], wordTiming: 'estimated', timingNote: '拖音，未经录音验证' }] };
    const plan = planSourceUpload(track, undefined, record(estimated));
    expect(plan.track.lyrics[0]).toEqual(estimated.lyrics[0]);
    expect(sourceSyncTrigger([estimated])).not.toBe(sourceSyncTrigger([{ ...estimated, lyrics: estimated.lyrics.map(({ wordTiming: _kind, timingNote: _note, ...line }) => line) }]));
  });
  it('fills only missing translations and does not replace richer remote lyrics with an old local copy', async () => {
    const source = fixture(); const track = song(); source.remote.set(track.id, record(track));
    const missing = { ...track, lyrics: [{ time: 0, text: 'Light' }] };
    expect(await source.run([missing])).toMatchObject({ uploaded: 0, unchanged: 1 });
    const different = { ...track, lyrics: [{ time: 0, text: 'Light', translation: '另一种说法' }] };
    expect(await source.run([different])).toMatchObject({ uploaded: 0, conflicts: 1 });
    const extended = { ...track, lyrics: [{ time: 0, text: 'Light', translation: '' }, { time: 1, text: 'Home', translation: '家' }] };
    source.remote.set(track.id, record({ ...track, lyrics: [{ time: 0, text: 'Light', translation: '光' }, { time: 1, text: 'Home' }] }, 2));
    expect(await source.run([extended])).toMatchObject({ uploaded: 1 });
    expect(source.remote.get(track.id)?.metadata.lyrics.map((line) => line.translation)).toEqual(['光', '家']);
  });
  it('requires server support and write authority before any writes; cancellation makes no requests', async () => {
    const source = fixture(); source.readOnly();
    await expect(source.run([song()])).rejects.toThrow('读取权限'); expect(source.upload).not.toHaveBeenCalled();
    const old = fixture(); old.oldServer(); await expect(old.run([song()])).rejects.toThrow('先更新'); expect(old.upload).not.toHaveBeenCalled();
    const cancelled = fixture(); const controller = new AbortController(); controller.abort();
    await expect(cancelled.run([song()], 'scope', controller.signal)).rejects.toThrow(); expect(cancelled.request).not.toHaveBeenCalled();
  });
  it('repairs corrupted remote audio instead of incorrectly treating a same-sized blob as a duplicate', async () => {
    const source = fixture(); const track = song(); source.remote.set(track.id, record(track)); source.corrupt();
    expect(await source.run([track])).toMatchObject({ uploaded: 1, errors: 0 });
    expect(source.upload).toHaveBeenCalledTimes(1);
  });
  it('isolates checkpoints by server identity, token and library, without including secrets in their keys', () => {
    const first = sourceSyncKey(config, 'one', song().id);
    expect(first).not.toContain(config.token); expect(first).not.toContain(config.baseUrl);
    expect(first).not.toBe(sourceSyncKey(config, 'two', song().id));
    expect(first).not.toBe(sourceSyncKey({ ...config, token: 'other' }, 'one', song().id));
  });
});
