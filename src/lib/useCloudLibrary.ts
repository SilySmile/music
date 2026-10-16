import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { Track } from '../types';
import { downloadSourceTrack, listSource, loadSourceConfig, sourceRequest, type SourceConfig, type SourceInfo, type SourceTrack } from './onlineSource';
import { cloudPreferences, cloudTrack } from './cloudLibrary';
import { patchTrack, sourceLibraryScope } from './storage';
import { androidPlayer, prepareAndroidQueue } from './androidPlayback';

export function useCloudLibrary(onCached: (track: Track) => void) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [message, setMessage] = useState('');
  const [caching, setCaching] = useState(false);
  const cachedCallback = useRef(onCached); cachedCallback.current = onCached;
  const config = useRef<SourceConfig | undefined>(undefined);
  const active = useRef<{ id: string; controller: AbortController; promise: Promise<Track | undefined> } | undefined>(undefined);
  const currentTracks = useRef(tracks); currentTracks.current = tracks;
  const mounted = useRef(true);
  const reload = useRef<() => void>(() => {});
  const refresh = useCallback(() => reload.current(), []);
  const patch = useCallback((id: string, value: Partial<Track>) => {
    const preferences = cloudPreferences(value);
    setTracks((previous) => previous.map((track) => track.id === id ? { ...track, ...preferences } : track));
    const key = `xianqiji-cloud-preference:${config.current?.baseUrl}:${id}`;
    try { const previous = cloudPreferences(JSON.parse(localStorage.getItem(key) || '{}')); localStorage.setItem(key, JSON.stringify({ ...previous, ...preferences })); } catch { setMessage('云端歌曲偏好暂时无法保存，请检查本机空间。'); }
  }, []);
  const generation = useRef(0);
  const cachePaused = useRef(false);
  const pending = useRef(new Map<string, Promise<Track | undefined>>());
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const stop = useCallback(() => { cachePaused.current = true; generation.current += 1; active.current?.controller.abort(); setMessage('已停止缓存队列，已完整保存的歌曲保留在当前音乐库。'); }, []);
  const cache = useCallback((track: Track, manual = true): Promise<Track | undefined> => {
    if (!track.cloud) return Promise.resolve(track);
    if (manual) cachePaused.current = false; else if (cachePaused.current) return Promise.resolve(undefined);
    const currentGeneration = generation.current;
    const key = `${currentGeneration}:${track.cloud.source}:${track.id}`;
    const existing = pending.current.get(key); if (existing) return existing;
    setCaching(true);
    const promise = tail.current.then(async () => {
      if (!mounted.current || generation.current !== currentGeneration) return undefined;
      const controller = new AbortController();
      const operation = { id: track.id, controller, promise: Promise.resolve(undefined as Track | undefined) };
      active.current = operation;
      try {
        const scope = await sourceLibraryScope(); controller.signal.throwIfAborted();
        const { audio: _audio, cover: _cover, cloud: _cloud, ...metadata } = track;
        const record = { ...track.cloud!.record, metadata: { ...metadata, lastPlayed: track.lastPlayed || Date.now() } };
        let saved = await downloadSourceTrack(record, (value) => { if (mounted.current) setMessage(value); }, controller.signal, async (request, signal) => {
          if (scope !== await sourceLibraryScope()) throw new Error('音乐库位置已变化，已停止缓存。');
          return sourceRequest(request, signal);
        });
        const preferences = cloudPreferences(JSON.parse(localStorage.getItem(`xianqiji-cloud-preference:${track.cloud!.source}:${track.id}`) || '{}'));
        if (Object.keys(preferences).length) saved = await patchTrack(saved.id, preferences);
        if (mounted.current) { cachedCallback.current(saved); setMessage(`已保存到当前本地音乐库 · ${saved.title}`); }
        if (Capacitor.getPlatform() === 'android') {
          await prepareAndroidQueue([saved], () => {}, controller.signal).catch(() => {});
          void androidPlayer.control({ action: 'cached', text: saved.id }).catch(() => {});
        }
        return saved;
      } catch (error) {
        if (mounted.current && !controller.signal.aborted) setMessage(`缓存未完成，不标记为已缓存：${error instanceof Error ? error.message : '请检查存储空间。'}`);
        return undefined;
      } finally { if (active.current === operation) active.current = undefined; }
    }).finally(() => { pending.current.delete(key); if (mounted.current) setCaching(pending.current.size > 0); });
    pending.current.set(key, promise); tail.current = promise;
    return promise;
  }, []);
  useEffect(() => {
    mounted.current = true; let revision = 0; let requestRevision = 0; let controller: AbortController | undefined;
    const apply = (records: SourceTrack[], saved: SourceConfig, info: SourceInfo) => {
      const list = records.map((record) => {
        const track = cloudTrack(record, saved, info.publicRead === true && info.streaming === true);
        try { const preferences = cloudPreferences(JSON.parse(localStorage.getItem(`xianqiji-cloud-preference:${saved.baseUrl}:${track.id}`) || '{}')); return { ...track, ...preferences }; } catch { return track; }
      });
      setTracks(list); setMessage(`云端 ${list.length} 首已加入全部歌曲，点播时保存到当前本地音乐库。`);
    };
    const load = async (force = false) => {
      const requested = ++requestRevision;
      const saved = await loadSourceConfig();
      if (!mounted.current || requested !== requestRevision) return;
      const enabled = saved.connected ?? !!saved.token;
      const identity = `${saved.baseUrl}|${saved.token}|${enabled}`;
      if (!force && config.current && `${config.current.baseUrl}|${config.current.token}|${config.current.connected ?? !!config.current.token}` === identity) return;
      const sequence = ++revision;
      config.current = saved; controller?.abort(); generation.current += 1; active.current?.controller.abort();
      if (!enabled) { setTracks([]); return; }
      controller = new AbortController();
      setMessage('正在读取云端歌曲信息，不下载整库音频…');
      const info = await sourceRequest<SourceInfo>({ method: 'GET', path: '/info' }, controller.signal);
      if (info.product !== 'xianqiji-online-library' || info.schema !== 1) throw new Error('不是兼容的云端音乐服务。');
      const records = await listSource(sourceRequest, controller.signal);
      if (!mounted.current || sequence !== revision) return;
      apply(records, saved, info);
    };
    const handle = () => { void load().catch((error) => { if (mounted.current) setMessage(error.message); }); };
    const catalog = (event: Event) => { const data = (event as CustomEvent<{ config: SourceConfig; info: SourceInfo; records: SourceTrack[] }>).detail; revision += 1; controller?.abort(); config.current = data.config; apply(data.records, data.config, data.info); };
    reload.current = () => { void load(true).catch((error) => { if (mounted.current) setMessage(error.message); }); };
    const nativeTrack = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const track = currentTracks.current.find((track) => track.id === id);
      if (track && !pending.current.has(`${generation.current}:${track.cloud?.source}:${id}`) && !cachePaused.current) { patch(id, { lastPlayed: Date.now() }); void cache({ ...track, lastPlayed: Date.now() }, false); }
    };
    handle(); window.addEventListener('xianqiji-cloud-catalog', catalog); window.addEventListener('xianqiji-source-config-changed', handle); window.addEventListener('xianqiji-cloud-played', nativeTrack); window.addEventListener('online', refresh);
    return () => { mounted.current = false; revision += 1; requestRevision += 1; controller?.abort(); active.current?.controller.abort(); window.removeEventListener('xianqiji-cloud-catalog', catalog); window.removeEventListener('xianqiji-source-config-changed', handle); window.removeEventListener('xianqiji-cloud-played', nativeTrack); window.removeEventListener('online', refresh); };
  }, [cache, patch, refresh]);
  return { tracks, message, caching, cache, patch, refresh, stop };
}
