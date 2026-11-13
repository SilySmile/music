import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cloudPreferences, cloudTrack, mergeCloudTracks } from './cloudLibrary';
import { nativeAudioUrl } from './nativeAudio';
import type { SourceRequester, SourceTrack } from './onlineSource';

const bytes = new Uint8Array([1, 2, 3]);
const id = createHash('sha256').update(bytes).digest('hex');
const record: SourceTrack = { metadata: { id, title: 'Song', artist: 'Artist', album: 'Album', format: 'WAV', duration: 1, lyrics: [{ time: 0, text: 'Light', translation: '光' }], favorite: false, addedAt: 1 }, audio: { sha256: id, size: bytes.length, type: 'audio/wav' }, revision: 1, updatedAt: 1 };

describe('cloud catalog entries', () => {
  it('persists only editable preferences, never media, source config or identity', () => {
    expect(cloudPreferences({ id: 'replacement', audio: new Blob(['audio']), favorite: false, lastPlayed: 10, lyrics: record.metadata.lyrics })).toEqual({ favorite: false, lastPlayed: 10, lyrics: record.metadata.lyrics });
  });
  it('lists music without reading audio and keeps stream URLs free of credentials', async () => {
    const request = vi.fn(async () => ({ data: btoa(String.fromCharCode(...bytes)), offset: 0, size: bytes.length, sha256: id })) as unknown as SourceRequester;
    const track = cloudTrack(record, { baseUrl: 'https://example.com/music-library/', token: 'must-not-leak', remember: false }, true, request);
    expect(request).not.toHaveBeenCalled();
    expect(track.audio.size).toBe(3);
    expect(nativeAudioUrl(track.audio)).toBe(`https://example.com/music-library/tracks/${id}/stream/audio`);
    expect(JSON.stringify(track)).not.toContain('must-not-leak');
    expect(new Uint8Array(await track.audio.arrayBuffer())).toEqual(bytes);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('uses local music in preference to the same cloud audio without hiding unplayed songs', () => {
    const track = cloudTrack(record, { baseUrl: 'https://example.com', token: '', remember: false }, true);
    const { cloud: _cloud, ...local } = track;
    expect(mergeCloudTracks([local], [track])).toEqual([local]);
    expect(mergeCloudTracks([], [track])).toEqual([track]);
    expect(nativeAudioUrl(cloudTrack(record, { baseUrl: 'https://example.com', token: 'private', remember: false }, false).audio)).toBe('');
  });
  it('reads private audio larger than the server chunk limit without saving it to the library', async () => {
    const content = Buffer.alloc(2 * 1024 * 1024 + 3, 42);
    const hash = createHash('sha256').update(content).digest('hex');
    const large = { ...record, metadata: { ...record.metadata, id: hash }, audio: { ...record.audio, sha256: hash, size: content.length } };
    const ranges: number[] = [];
    const request: SourceRequester = async <T>(options: { path: string }) => {
      const url = new URL(options.path, 'https://example.com');
      const offset = Number(url.searchParams.get('offset')), length = Number(url.searchParams.get('length'));
      expect(length).toBeLessThanOrEqual(1024 * 1024); ranges.push(length);
      return { data: content.subarray(offset, offset + length).toString('base64'), offset, size: content.length, sha256: hash } as T;
    };
    const track = cloudTrack(large, { baseUrl: 'https://example.com/', token: 'private', remember: false }, false, request);
    expect(Buffer.from(await track.audio.arrayBuffer())).toEqual(content);
    expect(ranges).toEqual([1024 * 1024, 1024 * 1024, 3]);
  });
});
