import { useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { Capacitor } from '@capacitor/core';
import type { AIConfig, Track } from '../types';
import { emptyAutoAlignment, runAutomaticAlignment } from './automaticAlignment';
import { cacheTranslation, getCachedTranslation, sourceLibraryScope } from './storage';

const fingerprint = (track: Track) => JSON.stringify([track.id, track.lyrics.map(({ time, text, words }) => [time, text, words])]);
const digest = (text: string) => Array.from(sha256(new TextEncoder().encode(text)), (byte) => byte.toString(16).padStart(2, '0')).join('');
export function useAutomaticAlignment(tracks: Track[], ready: boolean, config: AIConfig, blocked: boolean, save: (id: string, patch: Partial<Track>) => Promise<boolean>, onBusy: (busy: boolean) => void) {
  const [state, setState] = useState(emptyAutoAlignment);
  const view = useRef({ tracks, ready, config, blocked, save, onBusy }); view.current = { tracks, ready, config, blocked, save, onBusy };
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const paused = useRef(false);
  const retryRequested = useRef<boolean | 'failed'>(false);
  const schedule = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const run = useRef<() => void>(() => {});
  const lastRun = useRef('');
  const trigger = digest(JSON.stringify(tracks.map(fingerprint)));
  const configKey = digest(JSON.stringify(config));
  const check = useCallback(() => { clearTimeout(schedule.current); schedule.current = setTimeout(() => run.current(), 1200); }, []);
  const pause = useCallback(() => { paused.current = true; clearTimeout(schedule.current); active.current?.abort(); setState((previous) => ({ ...previous, message: '自动生成已暂停，已保存的逐字文件保留。' })); }, []);
  const retry = useCallback(() => { paused.current = false; retryRequested.current = true; lastRun.current = ''; check(); }, [check]);
  run.current = () => {
    const current = view.current;
    if (!mounted.current || paused.current || active.current || !current.ready || current.blocked || !current.config.autoAlign || !current.config.key || (Capacitor.getPlatform() === 'android' && document.hidden) || !navigator.onLine) return;
    const revision = digest(JSON.stringify([current.config, current.tracks.map(fingerprint)]));
    if (lastRun.current === revision && !retryRequested.current) return;
    lastRun.current = revision;
    const controller = new AbortController(); active.current = controller;
    const retry = retryRequested.current; retryRequested.current = false;
    current.onBusy(true);
    void (async () => {
      try {
        const scope = await sourceLibraryScope();
        await runAutomaticAlignment({ tracks: current.tracks, config: current.config, signal: controller.signal, retry,
          cache: { get: getCachedTranslation, set: cacheTranslation },
          progress: (next) => { if (mounted.current) setState(next); },
          save: async (expected, result) => {
            controller.signal.throwIfAborted();
            const latest = view.current.tracks.find((track) => track.id === expected.id);
            if (!latest || view.current.blocked || fingerprint(latest) !== fingerprint(expected) || await sourceLibraryScope() !== scope) throw new Error('识别期间歌曲或曲库已改变，未覆盖当前歌词。');
            const lyrics = result.lyrics.map((line, index) => ({ ...line, translation: latest.lyrics[index].translation }));
            if (!await view.current.save(expected.id, { lyrics })) throw new Error('逐字歌词写入失败，原歌词保留。');
          },
        });
      } catch (error) { if (mounted.current) setState((previous) => ({ ...previous, running: false, message: error instanceof Error ? error.message : '逐字歌词生成失败。' })); }
      finally { if (active.current === controller) active.current = null; current.onBusy(false); if (mounted.current) check(); }
    })();
  };
  useEffect(() => {
    mounted.current = true;
    const stop = () => active.current?.abort();
    const visible = () => { if (Capacitor.getPlatform() === 'android' && document.hidden) stop(); else check(); };
    const configured = () => { paused.current = false; if (!active.current) retryRequested.current = 'failed'; lastRun.current = ''; check(); };
    window.addEventListener('online', check); window.addEventListener('offline', stop);
    window.addEventListener('xianqiji-ai-config-changed', configured);
    document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; clearTimeout(schedule.current); stop(); window.removeEventListener('online', check); window.removeEventListener('offline', stop); window.removeEventListener('xianqiji-ai-config-changed', configured); document.removeEventListener('visibilitychange', visible); };
  }, [check]);
  useEffect(() => { active.current?.abort(); check(); }, [configKey, check]);
  useEffect(() => { if (blocked || !ready) active.current?.abort(); else check(); }, [trigger, ready, blocked, check]);
  return { state, pause, retry };
}
