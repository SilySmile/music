import { useSyncExternalStore } from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type TaskView = 'settings' | 'import' | 'export' | 'online' | 'lyrics' | 'lyric-settings' | 'transfers';
export type BackgroundStatus = 'running' | 'paused' | 'failed' | 'completed' | 'review';
export type BackgroundTask = { id: string; title: string; message: string; status: BackgroundStatus; view: TaskView; updatedAt: number; persistent?: boolean };
interface NativeTasks {
  begin(options: { id: string; title: string }): Promise<void>;
  update(options: { id: string; message: string }): Promise<void>;
  finish(options: { id: string }): Promise<void>;
  openPowerSettings(): Promise<void>;
  addListener(event: 'control', listener: (event: { action: string; reason?: string }) => void): Promise<PluginListenerHandle>;
}
const native = registerPlugin<NativeTasks>('BackgroundTasks');
const entries = new Map<string, BackgroundTask>();
const active = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let snapshot: BackgroundTask[] = [];
let nativePaused = false;
let nativeListener: Promise<PluginListenerHandle> | undefined;
let lastNativeUpdate = 0;
let lastJournalWrite = 0;
const journalKey = 'xianqiji-background-tasks-v1';

function publish(durable = true) {
  while (entries.size > 60) {
    const removable = [...entries.values()].find((task) => task.status !== 'review' && !active.has(task.id));
    if (!removable) break;
    entries.delete(removable.id);
  }
  snapshot = [...entries.values()].sort((first, second) => second.updatedAt - first.updatedAt);
  if (durable || Date.now() - lastJournalWrite >= 1000) { lastJournalWrite = Date.now(); try { localStorage.setItem(journalKey, JSON.stringify(snapshot.slice(0, 60))); } catch {} }
  for (const listener of listeners) listener();
}
export function restoreBackgroundTasks() {
  try {
    const saved = JSON.parse(localStorage.getItem(journalKey) || '[]');
    if (!Array.isArray(saved)) return;
    for (const task of saved.slice(0, 60)) {
      if (!task || typeof task.id !== 'string' || typeof task.title !== 'string' || !['settings', 'import', 'export', 'online', 'lyrics', 'lyric-settings', 'transfers'].includes(task.view) || entries.has(task.id)) continue;
      if (!['running', 'paused', 'failed', 'completed', 'review'].includes(task.status)) continue;
      entries.set(task.id, { id: task.id, title: task.title, view: task.view, persistent: task.persistent === true, updatedAt: Number(task.updatedAt) || 0, status: task.status === 'running' || task.status === 'review' ? 'paused' : task.status, message: task.status === 'running' || task.status === 'review' ? '上次运行或未保存草稿已中断；请核对后手动继续，付费请求不会自动重发。' : String(task.message || '') });
    }
    publish();
  } catch {}
}
export function useBackgroundTasks() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => snapshot);
}
export function backgroundRunning() { return active.size > 0; }
export function isAndroidBackground() { return Capacitor.getPlatform() === 'android'; }
export function openBackgroundPowerSettings() { return native.openPowerSettings(); }
export function androidBackgroundAvailable() { return Capacitor.getPlatform() !== 'android' || !nativePaused && active.size > 0; }
export function resumeBackgroundTasks() { nativePaused = false; if (typeof window !== 'undefined') window.dispatchEvent(new Event('xianqiji-background-resume')); }
export function pauseBackgroundTasks(reason = '已暂停后台任务。') {
  nativePaused = true;
  for (const controller of active.values()) controller.abort(new DOMException(reason, 'AbortError'));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('xianqiji-background-paused', { detail: reason }));
}
export function pauseBackgroundTask(id: string) { active.get(id)?.abort(); }
export function dismissBackgroundTask(id: string) { if (!active.has(id)) { entries.delete(id); publish(); } }
export function completeBackgroundTask(id: string, message: string) { const task = entries.get(id); if (task && !active.has(id)) { entries.set(id, { ...task, status: 'completed', message, updatedAt: Date.now() }); publish(); } }

export async function beginBackgroundTask(options: { id: string; title: string; view: TaskView; signal?: AbortSignal; controller?: AbortController; persistent?: boolean }) {
  if (active.has(options.id)) throw new Error('这个任务已在后台运行，请到任务中心查看。');
  const controller = options.controller || new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  controller.signal.throwIfAborted();
  if (nativePaused) throw new Error('后台任务已暂停，请到任务中心允许继续。');
  options.signal?.addEventListener('abort', abort, { once: true });
  active.set(options.id, controller);
  try {
    if (Capacitor.getPlatform() === 'android') {
      if (!nativeListener) {
        nativeListener = native.addListener('control', (event) => {
          if (event.action === 'pause') pauseBackgroundTasks(event.reason);
        });
      }
      await nativeListener;
      await native.begin({ id: options.id, title: options.title });
    }
    controller.signal.throwIfAborted();
  } catch (error) {
    active.delete(options.id); options.signal?.removeEventListener('abort', abort);
    if (Capacitor.getPlatform() === 'android') await native.finish({ id: options.id }).catch(() => {});
    throw error;
  }
  entries.set(options.id, { id: options.id, title: options.title, view: options.view, persistent: options.persistent, status: 'running', message: '正在准备…', updatedAt: Date.now() });
  publish();
  let finished = false;
  return {
    signal: controller.signal,
    progress(message: string) {
      if (finished) return;
      const task = entries.get(options.id)!;
      entries.set(options.id, { ...task, message, updatedAt: Date.now() }); publish(false);
      if (Capacitor.getPlatform() === 'android' && Date.now() - lastNativeUpdate > 1000) { lastNativeUpdate = Date.now(); void native.update({ id: options.id, message }).catch(() => {}); }
    },
    async finish(status: BackgroundStatus = 'completed', message = '任务已完成。') {
      if (finished) return;
      finished = true; active.delete(options.id); options.signal?.removeEventListener('abort', abort);
      entries.set(options.id, { ...entries.get(options.id)!, status, message, updatedAt: Date.now() }); publish();
      if (Capacitor.getPlatform() === 'android') await native.finish({ id: options.id }).catch(() => {});
    },
  };
}
export type BackgroundHandle = Awaited<ReturnType<typeof beginBackgroundTask>>;
