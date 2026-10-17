import { sha256 } from '@noble/hashes/sha2.js';
import type { ForcedAlignConfig, Track } from '../types';
import { checkForcedAlignment, forcedTargets, generateForcedAlignment, needsForcedAlignment } from './forcedAlignment';
import { timingFingerprint } from './lyricTimingEditor';

export type ForcedQueueState = { running: boolean; message: string; completed: number; total: number; failed: number };
export const emptyForcedQueue: ForcedQueueState = { running: false, message: '', completed: 0, total: 0, failed: 0 };
export function forcedTaskKey(track: Track, scope: string, config: ForcedAlignConfig) {
  const source = JSON.stringify([scope, config.url, config.model, track.id, timingFingerprint(track.lyrics)]);
  return Array.from(sha256(new TextEncoder().encode(source)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function runForcedQueue(options: {
  tracks: Track[]; config: ForcedAlignConfig; signal: AbortSignal; scope: string;
  attempted: Set<string>; remember(): void; currentScope(): Promise<string>;
  save(track: Track, lyrics: Track['lyrics'], signal: AbortSignal): Promise<void>; progress(state: ForcedQueueState): void;
  health?: typeof checkForcedAlignment; generate?: typeof generateForcedAlignment;
}) {
  const { config, signal, attempted } = options;
  const health = options.health || checkForcedAlignment;
  const generate = options.generate || generateForcedAlignment;
  const candidates = options.tracks.filter((track) => needsForcedAlignment(track) && forcedTargets(track).length && !attempted.has(forcedTaskKey(track, options.scope, config)));
  const state = { ...emptyForcedQueue, total: candidates.length };
  if (!candidates.length) { options.progress({ ...state, message: '缺失或旧 AI 估算的逐字时间已检查；失败项可手动重试。' }); return; }
  const status = await health(config, signal);
  if (!status.ready || !status.resource_ready) { options.progress({ ...state, message: status.reason || '强对齐服务准备中，稍后自动检查。' }); return; }
  state.running = true; state.message = `正在本地强对齐 0 / ${state.total}…`; options.progress({ ...state });
  let cursor = 0, limited = false;
  async function worker() {
    while (!signal.aborted && !limited && cursor < candidates.length) {
      const track = candidates[cursor++]; const key = forcedTaskKey(track, options.scope, config);
      signal.throwIfAborted();
      if (await options.currentScope() !== options.scope) throw new Error('音乐库已改变，本轮强对齐停止。');
      const resources = await health(config, signal);
      if (!resources.ready || !resources.resource_ready) { limited = true; state.message = resources.reason || '资源紧张，稍后继续'; break; }
      attempted.add(key); options.remember();
      try {
        const result = await generate(track, config, signal);
        signal.throwIfAborted();
        if (await options.currentScope() !== options.scope) throw new Error('音乐库已改变，未保存本轮结果。');
        if (result.matched) await options.save(track, result.lyrics, signal);
        signal.throwIfAborted();
        // Partial results must not continuously requeue unmatched phrases.
        attempted.add(forcedTaskKey({ ...track, lyrics: result.lyrics }, options.scope, config));
        if (result.unmatched || !result.matched) state.failed++;
      } catch (error) {
        if (signal.aborted) { attempted.delete(key); options.remember(); throw error; }
        const message = error instanceof Error ? error.message : '强对齐失败';
        if (/503|429|fetch|连接|ECONN|Failed to fetch/i.test(message)) { attempted.delete(key); limited = true; state.message = '服务停止、队列繁忙或资源紧张，稍后自动检查。'; }
        else { state.failed++; state.message = message; }
      } finally {
        state.completed++; options.remember();
        if (!limited) state.message = `本地强对齐 ${state.completed} / ${state.total}，需检查 ${state.failed} 首。`;
        options.progress({ ...state });
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(2, config.concurrency, status.concurrency || 1)) }, worker);
  const results = await Promise.allSettled(workers);
  state.running = false; options.progress({ ...state });
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
