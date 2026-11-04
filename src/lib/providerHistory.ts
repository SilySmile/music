import { providerIdentifier, validateProviderResult, type ProviderSearchResult } from './providerSearch';
import { sha256 } from '@noble/hashes/sha2.js';
import { remoteAudio } from './nativeAudio';
import type { Track } from '../types';
export type ProviderRecent = { song: ProviderSearchResult; lastPlayed: number; localId?: string };
const key = 'xianqiji-provider-recent-v2';
export function recentProvider(song: ProviderSearchResult, now = Date.now()): ProviderRecent {
  validateProviderResult(song);
  return { song: { id: song.id, provider: song.provider, title: song.title, artist: song.artist, album: song.album, duration: song.duration, capabilities: { ...song.capabilities } }, lastPlayed: now };
}
export function addProviderRecent(previous: ProviderRecent[], entry: ProviderRecent) {
  const same = (item: ProviderRecent) => providerIdentifier(item.song.provider, item.song.id) === providerIdentifier(entry.song.provider, entry.song.id);
  return [{ ...entry, localId: entry.localId || previous.find(same)?.localId }, ...previous.filter((item) => !same(item))].sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 200);
}
export function readProviderRecent(storage: Pick<Storage, 'getItem'> = localStorage): ProviderRecent[] {
  try { return parseProviderRecent(JSON.parse(storage.getItem(key) || '[]')); } catch { return []; }
}
export function parseProviderRecent(values: unknown): ProviderRecent[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 200).flatMap((entry) => { try { if (!Number.isFinite(entry.lastPlayed) || entry.lastPlayed < 0) return []; const record = recentProvider(entry.song, entry.lastPlayed); if (typeof entry.localId === 'string' && /^[a-f0-9]{64}$/.test(entry.localId)) record.localId = entry.localId; return [record]; } catch { return []; } });
}
export function mergeProviderRecent(previous: ProviderRecent[], incoming: unknown): ProviderRecent[] {
  return parseProviderRecent(incoming).reduce((items, entry) => {
    const old = items.find((item) => providerIdentifier(item.song.provider, item.song.id) === providerIdentifier(entry.song.provider, entry.song.id));
    return old && old.lastPlayed >= entry.lastPlayed ? items : addProviderRecent(items, entry);
  }, previous);
}
export function saveProviderRecent(values: ProviderRecent[], storage: Pick<Storage, 'setItem'> = localStorage) { storage.setItem(key, JSON.stringify(values.slice(0, 200))); }
export function recentPlaybackTracks(library: Track[], history: ProviderRecent[]): Track[] {
  const items = new Map(library.filter((track) => track.lastPlayed).map((track) => [track.id, track]));
  for (const entry of history) { const local = entry.localId && library.find((track) => track.id === entry.localId); const track = local || externalTrack(entry); const lastPlayed = Math.max(entry.lastPlayed, items.get(track.id)?.lastPlayed || 0, track.lastPlayed || 0); items.set(track.id, { ...track, lastPlayed }); }
  return [...items.values()].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}
export function externalTrack(entry: ProviderRecent, streamUrl = '', lyrics: Track['lyrics'] = []): Track {
  const song = entry.song; const id = Array.from(sha256(new TextEncoder().encode(`provider:${providerIdentifier(song.provider, song.id)}`)), (value) => value.toString(16).padStart(2, '0')).join('');
  return { id, title: song.title, artist: song.artist, album: song.album, duration: song.duration, format: song.provider === 'qq' ? 'QQ 音乐' : '网易云音乐', audio: remoteAudio(streamUrl), lyrics, lyricsSource: lyrics.length ? 'LRCLIB' : undefined, favorite: false, addedAt: 0, lastPlayed: entry.lastPlayed, external: { song } };
}
