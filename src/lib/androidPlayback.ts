import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Track } from '../types';
import type { PlaybackMode } from './playback';
export type AndroidPlaybackState = { active: boolean; id?: string; playing?: boolean; position?: number; duration?: number; mode?: PlaybackMode; volume?: number; deadline?: number; finishTrack?: boolean; error?: string; cloudPlayed?: string[]; providerRecent?: unknown[]; queueIds?: string[] };
type QueueOptions = { tracks: { id: string; title: string; artist: string; album: string; duration: number; sourceUrl?: string; contentUri?: string; provider?: 'qq' | 'netease'; providerTrackId?: string }[]; id: string; position: number; playing: boolean; mode: PlaybackMode; volume: number; fade: number; deadline: number; finishTrack: boolean; updateOnly?: boolean };
export type AndroidSavedPosition = { scope?: string; id?: string; position?: number; duration?: number };
interface PlaybackPlugin {
  notifications(): Promise<void>;
  cached(options: { tracks: { id: string; size: number }[] }): Promise<{ ids: string[] }>;
  write(options: { id: string; offset: number; data: string }): Promise<void>;
  finish(options: { id: string; size: number }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
  setQueue(options: QueueOptions): Promise<void>;
  control(options: { action: string; value?: number; text?: string }): Promise<void>;
  state(): Promise<AndroidPlaybackState>;
  savedPosition(options: { scope: string }): Promise<AndroidSavedPosition>;
  addListener(event: 'state', listener: (state: AndroidPlaybackState) => void): Promise<PluginListenerHandle>;
}
export const androidPlayer = registerPlugin<PlaybackPlugin>('NativePlayback');
export const isAndroidPlayer = () => Capacitor.getPlatform() === 'android';

export function savedAndroidPosition(saved: AndroidSavedPosition, scope: string, tracks: Track[]) {
  const track = tracks.find((track) => track.id === saved.id);
  if (!track || saved.scope !== scope || !Number.isFinite(saved.position) || saved.position! < 0) return undefined;
  return { id: track.id, position: track.duration > 0 ? Math.min(saved.position!, track.duration) : saved.position! };
}

/** Query the service when returning to the foreground, even if WebView missed broadcasts. */
export function observeAndroidPlayback(receive: (state: AndroidPlaybackState) => void, page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document) {
  let disposed = false;
  let querying = false;
  let remove: (() => void) | undefined;
  const deliver = (state: AndroidPlaybackState) => { if (!disposed) receive(state); };
  const refresh = async () => {
    if (disposed || page.hidden || querying) return;
    querying = true;
    try { deliver(await androidPlayer.state()); } catch { /* A later tick retries the bridge. */ }
    finally { querying = false; }
  };
  void androidPlayer.addListener('state', deliver).then((listener) => {
    if (disposed) void listener.remove(); else remove = () => void listener.remove();
  }).catch(() => {});
  void refresh();
  const timer = setInterval(() => void refresh(), 1000);
  page.addEventListener('visibilitychange', refresh);
  return () => { disposed = true; clearInterval(timer); remove?.(); page.removeEventListener('visibilitychange', refresh); };
}

export async function prepareAndroidQueue(tracks: Track[], onProgress: (message: string) => void, signal: AbortSignal) {
  // Songs from the phone's own folder library are played straight from their SAF document URI,
  // so only tracks that live in the internal database need a private copy.
  tracks = tracks.filter((track) => !track.cloud && !track.contentUri && !track.external);
  const { ids } = await androidPlayer.cached({ tracks: tracks.map((track) => ({ id: track.id, size: track.audio.size })) });
  const cached = new Set(ids);
  const pending = tracks.filter((track) => !cached.has(track.id));
  for (const [index, track] of pending.entries()) {
    signal.throwIfAborted();
    onProgress(`首次准备后台播放 ${index + 1} / ${pending.length}，请保持前台；校验后下次复用`);
    for (let offset = 0; offset < track.audio.size; offset += 4 * 1024 * 1024) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await track.audio.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer());
      let binary = '';
      for (let position = 0; position < bytes.length; position += 8192) binary += String.fromCharCode(...bytes.subarray(position, position + 8192));
      await androidPlayer.write({ id: track.id, offset, data: btoa(binary) });
    }
    await androidPlayer.finish({ id: track.id, size: track.audio.size });
  }
}
export function androidQueueOptions(tracks: Track[], id: string, position: number, playing: boolean, mode: PlaybackMode, volume: number, fade: number, sleep: { deadline: number; behavior: 'immediate' | 'finish-track' } | null, libraryScope = ''): QueueOptions & { libraryScope: string } {
  return { tracks: tracks.map(({ id, title, artist, album, duration, cloud, contentUri, external }) => ({ id, title, artist, album, duration, ...(external ? { provider: external.song.provider, providerTrackId: external.song.id } : cloud?.publicRead ? { sourceUrl: cloud.streamUrl } : contentUri ? { contentUri } : {}) })), id, position, playing, mode, volume, fade, deadline: sleep?.deadline ?? 0, finishTrack: sleep?.behavior === 'finish-track', libraryScope };
}
