import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Track } from '../types';
import type { PlaybackMode } from './playback';
export type AndroidPlaybackState = { active: boolean; id?: string; playing?: boolean; position?: number; duration?: number; mode?: PlaybackMode; volume?: number; deadline?: number; finishTrack?: boolean; error?: string };
type QueueOptions = { tracks: { id: string; title: string; artist: string; album: string; duration: number }[]; id: string; position: number; playing: boolean; mode: PlaybackMode; volume: number; fade: number; deadline: number; finishTrack: boolean };
interface PlaybackPlugin {
  notifications(): Promise<void>;
  cached(options: { tracks: { id: string; size: number }[] }): Promise<{ ids: string[] }>;
  write(options: { id: string; offset: number; data: string }): Promise<void>;
  finish(options: { id: string; size: number }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
  setQueue(options: QueueOptions): Promise<void>;
  control(options: { action: string; value?: number; text?: string }): Promise<void>;
  state(): Promise<AndroidPlaybackState>;
  addListener(event: 'state', listener: (state: AndroidPlaybackState) => void): Promise<PluginListenerHandle>;
}
export const androidPlayer = registerPlugin<PlaybackPlugin>('NativePlayback');
export const isAndroidPlayer = () => Capacitor.getPlatform() === 'android';

export async function prepareAndroidQueue(tracks: Track[], onProgress: (message: string) => void, signal: AbortSignal) {
  const { ids } = await androidPlayer.cached({ tracks: tracks.map((track) => ({ id: track.id, size: track.audio.size })) });
  const cached = new Set(ids);
  for (const [index, track] of tracks.entries()) {
    signal.throwIfAborted();
    if (cached.has(track.id)) continue;
    onProgress(`首次准备后台播放 ${index + 1} / ${tracks.length}，请保持前台；校验后下次复用`);
    for (let offset = 0; offset < track.audio.size; offset += 1024 * 1024) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await track.audio.slice(offset, offset + 1024 * 1024).arrayBuffer());
      let binary = '';
      for (let position = 0; position < bytes.length; position += 8192) binary += String.fromCharCode(...bytes.subarray(position, position + 8192));
      await androidPlayer.write({ id: track.id, offset, data: btoa(binary) });
    }
    await androidPlayer.finish({ id: track.id, size: track.audio.size });
  }
}
export function androidQueueOptions(tracks: Track[], id: string, position: number, playing: boolean, mode: PlaybackMode, volume: number, fade: number, sleep: { deadline: number; behavior: 'immediate' | 'finish-track' } | null): QueueOptions {
  return { tracks: tracks.map(({ id, title, artist, album, duration }) => ({ id, title, artist, album, duration })), id, position, playing, mode, volume, fade, deadline: sleep?.deadline ?? 0, finishTrack: sleep?.behavior === 'finish-track' };
}
