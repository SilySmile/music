import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { Track } from '../types';
import { loadSourceConfig, saveSourceConfig, type SourceConfig } from './onlineSource';
import { emptySourceSync, runSourceAutoSync, sourceSyncTrigger, type SourceSyncState } from './sourceAutoSync';
import { sourceLibraryScope } from './storage';
import { androidBackgroundAvailable, beginBackgroundTask, type BackgroundHandle } from './backgroundTasks';

export type SourceAutoController = { state: SourceSyncState; pause(): Promise<void>; check(): void };
export function useSourceAutoSync(tracks: Track[], ready: boolean, blocked: boolean): SourceAutoController {
  const [state, setState] = useState<SourceSyncState>(emptySourceSync);
  const view = useRef({ tracks, ready, blocked }); view.current = { tracks, ready, blocked };
  const config = useRef<SourceConfig | undefined>(undefined);
  const active = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const paused = useRef(false);
  const rerun = useRef(false);
  const schedule = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const run = useRef<() => void>(() => {});
  const trigger = sourceSyncTrigger(tracks);
  const check = useCallback(() => { if (active.current) rerun.current = true; clearTimeout(schedule.current); schedule.current = setTimeout(() => run.current(), 1500); }, []);
  const pause = useCallback(async () => {
    paused.current = true; clearTimeout(schedule.current);
    const operation = active.current;
    if (operation) {
      setState((previous) => ({ ...previous, message: '正在暂停，等待当前网络请求完成…' }));
      operation.controller.abort(); await operation.promise;
    }
    const saved = await loadSourceConfig();
    await saveSourceConfig({ ...saved, autoSync: false });
    if (mounted.current) setState((previous) => ({ ...previous, enabled: false, running: false, message: '自动上传已暂停；已确认的上传检查点保留。' }));
  }, []);
  run.current = () => {
    const current = config.current;
    const hidden = Capacitor.getPlatform() === 'android' && document.hidden && !androidBackgroundAvailable();
    if (!mounted.current || paused.current || active.current || !current?.autoSync || !current.token || !view.current.ready || view.current.blocked || hidden || !navigator.onLine) return;
    const controller = new AbortController();
    const operation = { controller, promise: Promise.resolve() };
    active.current = operation;
    setState((previous) => ({ ...previous, enabled: true, running: true, message: '正在核对当前音乐库…' }));
    operation.promise = (async () => {
      let job: BackgroundHandle | undefined;
      let failed = false;
      try {
        job = await beginBackgroundTask({ id: 'source-auto', title: '自动核对与上传', view: 'settings', controller });
        const scope = await sourceLibraryScope(); controller.signal.throwIfAborted();
        await runSourceAutoSync({ tracks: [...view.current.tracks], config: current, scope, signal: controller.signal, progress: (value) => { job?.progress(value.message); if (mounted.current) setState(value); } });
      } catch (error) {
        failed = true;
        if (mounted.current) setState((previous) => ({ ...previous, running: false, message: controller.signal.aborted ? '已暂停本轮；网络或前台恢复后继续核对。' : error instanceof Error ? error.message : '自动核对失败，稍后重试。' }));
      } finally {
        await job?.finish(controller.signal.aborted ? 'paused' : failed ? 'failed' : 'completed', failed ? '本轮核对未完成，请在云端音乐设置查看原因。' : '本轮核对已结束；详情与失败项见云端音乐设置。');
        if (active.current === operation) active.current = null;
        if (mounted.current) setState((previous) => ({ ...previous, running: false }));
        if (rerun.current) { rerun.current = false; check(); }
      }
    })();
  };
  useEffect(() => {
    mounted.current = true;
    let revision = 0;
    const reload = (event?: Event) => {
      const sequence = ++revision;
      void loadSourceConfig().then((saved) => {
        if (!mounted.current || sequence !== revision) return;
        config.current = saved;
        if (!saved.autoSync) paused.current = true; else if (event) paused.current = false;
        setState((previous) => ({ ...previous, enabled: saved.autoSync === true, message: saved.autoSync && !saved.token ? '请重新填写曲库密钥以恢复自动上传。' : previous.message }));
        check();
      }).catch((error) => { if (mounted.current) setState((previous) => ({ ...previous, message: error.message })); });
    };
    const visibility = () => {
      if (!document.hidden) check();
    };
    const interval = setInterval(check, 60000);
    const offline = () => { active.current?.controller.abort(); };
    reload();
    window.addEventListener('xianqiji-source-config-changed', reload);
    window.addEventListener('online', check); window.addEventListener('offline', offline);
    window.addEventListener('xianqiji-background-resume', check);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false; revision += 1; clearInterval(interval); clearTimeout(schedule.current); active.current?.controller.abort();
      window.removeEventListener('xianqiji-source-config-changed', reload);
      window.removeEventListener('online', check); window.removeEventListener('offline', offline);
      window.removeEventListener('xianqiji-background-resume', check);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [check]);
  useEffect(() => {
    if (blocked) active.current?.controller.abort();
    else check();
  }, [trigger, ready, blocked, check]);
  return { state, pause, check };
}
