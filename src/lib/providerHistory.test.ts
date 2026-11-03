import { describe, expect, it } from 'vitest';
import { addProviderRecent, mergeProviderRecent, externalTrack, readProviderRecent, recentPlaybackTracks, recentProvider, saveProviderRecent } from './providerHistory';
const song = { id: '001abc', provider: 'qq' as const, title: 'song', artist: 'artist', album: 'album', duration: 180, coverUrl: 'https://cover.example/?token=private', capabilities: { playback: true, download: false } };
describe('external recent playback', () => {
  it('recovers native background playback without overwriting a newer play or losing its saved file link', () => {
    const previous = [{ ...recentProvider(song, 5), localId: 'a'.repeat(64) }];
    expect(mergeProviderRecent(previous, [recentProvider(song, 3)])).toBe(previous);
    expect(mergeProviderRecent(previous, [recentProvider(song, 8), { bad: true }])[0]).toMatchObject({ lastPlayed: 8, localId: 'a'.repeat(64) });
  });
  it('stores metadata only, deduplicates and preserves an explicit download link', () => {
    const first = { ...recentProvider(song, 1), localId: 'a'.repeat(64) };
    const other = recentProvider({ ...song, provider: 'netease', id: '123' }, 2);
    const values = addProviderRecent(addProviderRecent([first], other), recentProvider(song, 3));
    expect(values.map((item) => item.lastPlayed)).toEqual([3, 2]);
    expect(values[0].localId).toBe('a'.repeat(64));
    expect(JSON.stringify(values)).not.toMatch(/private|streamUrl|vkey|audio|cookie/i);
    let stored = ''; saveProviderRecent(values, { setItem: (_key, value) => { stored = value; } });
    expect(readProviderRecent({ getItem: () => stored })).toEqual(values);
    expect(readProviderRecent({ getItem: () => '[{"bad":true}]' })).toEqual([]);
  });
  it('displays external playback only in Recent and reuses a downloaded library track', () => {
    const entry = recentProvider(song, 5); const transient = externalTrack(entry, 'https://ws.stream.qqmusic.qq.com/audio.m4a?vkey=temporary');
    const local = { ...transient, id: 'a'.repeat(64), external: undefined, audio: new Blob(['file']), lastPlayed: 2 };
    const library = [local];
    expect(recentPlaybackTracks(library, [entry])).toHaveLength(2);
    const displayed = recentPlaybackTracks(library, [{ ...entry, localId: local.id }]);
    expect(displayed).toHaveLength(1); expect(displayed[0]).toMatchObject({ id: local.id, lastPlayed: 5, external: undefined });
    expect(library[0].lastPlayed).toBe(2); expect(library).toHaveLength(1);
  });
});
