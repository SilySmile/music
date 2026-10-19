import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIConfig, Track } from '../types';
import { sourceLibraryScope } from './storage';
import { emptyForcedQueue, runForcedQueue } from './forcedAlignmentQueue';
import { beginBackgroundTask, type BackgroundHandle } from './backgroundTasks';

const historyKey = 'xianqiji-forced-attempts-v1';
export function useForcedAlignment(tracks: Track[], ready: boolean, config: AIConfig, blocked: boolean, save: (track: Track, lyrics: Track['lyrics'], signal: AbortSignal) => Promise<void>, onBusy: (value: boolean) => void) {
  const [state, setState] = useState(emptyForcedQueue);
  const view = useRef({ tracks, ready, config, blocked, save, onBusy }); view.current = { tracks, ready, config, blocked, save, onBusy };
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const attempted = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tick = useRef<() => Promise<void>>(async () => {});
  const remember = useCallback(() => {
    while (attempted.current.size > 4000) attempted.current.delete(attempted.current.values().next().value!);
    try { localStorage.setItem(historyKey, JSON.stringify([...attempted.current])); } catch { /* Still bounded for this session. */ }
  }, []);
  tick.current = async () => {
    const current = view.current;
    if (!mounted.current || active.current || !current.ready || current.blocked || current.config.alignmentMode !== 'forced' || !current.config.forced?.automatic || !current.config.forced.key || !window.tingyuDesktop) return;
    const controller = new AbortController(); active.current = controller;
    let job: BackgroundHandle | undefined;
    let failed = false;
    try {
      job = await beginBackgroundTask({ id: 'forced-auto', title: '自动本地强对齐', view: 'settings', controller });
      const scope = await sourceLibraryScope(); controller.signal.throwIfAborted();
      await runForcedQueue({ tracks: [...current.tracks], config: current.config.forced, scope, currentScope: sourceLibraryScope, signal: controller.signal, attempted: attempted.current, remember, save: current.save, progress: (next) => { job?.progress(next.message); if (mounted.current) { setState(next); view.current.onBusy(next.running); } } });
    } catch (error) {
      failed = true;
      if (mounted.current) setState((previous) => ({ ...previous, running: false, message: controller.signal.aborted ? '本轮已暂停，未保存的结果已放弃。' : `等待本地强对齐服务：${error instanceof Error ? error.message : '连接不可用'}` }));
    } finally { await job?.finish(controller.signal.aborted ? 'paused' : failed ? 'failed' : 'completed', '本轮本地强对齐已结束，结果与待复核项见设置。'); if (active.current === controller) active.current = null; if (mounted.current) view.current.onBusy(false); }
  };
  const schedule = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => void tick.current(), 1500); }, []);
  const retry = useCallback(() => { attempted.current.clear(); remember(); schedule(); }, [remember, schedule]);
  const cancel = useCallback(() => { active.current?.abort(); }, []);
  useEffect(() => {
    mounted.current = true;
    try { const saved = JSON.parse(localStorage.getItem(historyKey) || '[]'); if (Array.isArray(saved)) attempted.current = new Set(saved.filter((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)).slice(-4000)); } catch { /* Empty history. */ }
    const interval = setInterval(schedule, 30000); schedule();
    return () => { mounted.current = false; clearInterval(interval); clearTimeout(timer.current); active.current?.abort(); view.current.onBusy(false); };
  }, [schedule]);
  useEffect(() => {
    active.current?.abort();
    if (!blocked && ready) schedule();
  }, [blocked, ready, config, schedule]);
  // Updated saved timings wake the next pass without canceling in-flight peers.
  useEffect(schedule, [tracks, schedule]);
  return { state, retry, cancel };
}
