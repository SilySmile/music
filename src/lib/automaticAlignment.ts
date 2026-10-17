import type { AIConfig, Track } from '../types';
import { alignmentSignature, needsWordAlignment, validateAudioAI, type AlignmentResult } from './audioAlignment';
import { generateWordAlignment } from './audioAI';
import { generateTextAlignment } from './textAlignment';
import { normalizeAIUrl } from './network';

export type AutoAlignmentState = { running: boolean; checked: number; skipped: number; generated: number; partial: number; failed: number; message: string };
export const emptyAutoAlignment: AutoAlignmentState = { running: false, checked: 0, skipped: 0, generated: 0, partial: 0, failed: 0, message: '' };
type Cache = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<unknown> };
export async function runAutomaticAlignment(options: { tracks: Track[]; config: AIConfig; signal: AbortSignal; cache: Cache; save(track: Track, result: AlignmentResult): Promise<void>; progress(state: AutoAlignmentState): void; generate?: typeof generateWordAlignment; retry?: boolean | 'failed' }) {
  const { config, signal, cache } = options;
  const state = { ...emptyAutoAlignment, running: true };
  const emit = (message: string) => { state.message = message; options.progress({ ...state }); };
  const tracks = options.tracks.filter((track) => !track.cloud);
  try {
    for (const track of tracks) {
      signal.throwIfAborted(); state.checked++;
      if (!needsWordAlignment(track)) { state.skipped++; continue; }
      if (config.alignmentMode === 'audio') validateAudioAI(config);
      else { normalizeAIUrl(config.url); if (!config.key.trim() || !config.model.trim()) throw new Error('请保存聊天 AI 服务、模型和 API Key。'); }
      const key = `audio-word-alignment-v1|${alignmentSignature(track, config)}`;
      let previous: { status?: string } | undefined;
      try { previous = JSON.parse(await cache.get(key) || 'null'); } catch { /* A corrupt checkpoint must not start another paid call. */ previous = { status: 'unknown' }; }
      signal.throwIfAborted();
      const retryThis = options.retry === true || (options.retry === 'failed' && previous && !['done', 'partial', 'unmatched'].includes(previous.status || ''));
      if (previous && !retryThis) {
        state.skipped++;
        if (previous.status === 'partial' || previous.status === 'unmatched') state.partial++;
        if (previous.status !== 'done' && previous.status !== 'partial' && previous.status !== 'unmatched') {
          state.failed++; emit('上次识别未确认完成，已停止自动调用，避免重复计费。可在 AI 配置中手动重试未完成项。');
          return { ...state, running: false };
        }
        continue;
      }
      // A durable checkpoint is written before submitting audio. A restart or
      // interrupted response cannot silently submit the same paid job again.
      await cache.set(key, JSON.stringify({ status: 'pending', at: Date.now() }));
      signal.throwIfAborted();
      emit(`正在生成逐字歌词 ${state.checked} / ${tracks.length} · ${track.title}`);
      try {
        const result = await (options.generate || (config.alignmentMode === 'audio' ? generateWordAlignment : generateTextAlignment))(track, config, signal, { stage: (text) => emit(`${track.title} · ${text}`) });
        signal.throwIfAborted();
        if (result.matched) { await options.save(track, result); state.generated++; }
        if (result.unmatched) state.partial++;
        const checkpoint = JSON.stringify({ status: result.matched ? result.unmatched ? 'partial' : 'done' : 'unmatched', at: Date.now(), matched: result.matched, unmatched: result.unmatched });
        await cache.set(key, checkpoint);
        if (result.matched) await cache.set(`audio-word-alignment-v1|${alignmentSignature({ ...track, lyrics: result.lyrics }, config)}`, checkpoint);
      } catch (error) {
        // Keep pending on cancellation: the provider may already have billed.
        if (!signal.aborted) await cache.set(key, JSON.stringify({ status: 'failed', at: Date.now() }));
        throw error;
      }
    }
    emit(`逐字歌词检查完成：生成 ${state.generated} 首，跳过 ${state.skipped} 首${state.partial ? `，${state.partial} 首有未匹配句子，保留原歌词且不反复调用` : ''}。`);
  } catch (error) {
    state.failed += signal.aborted ? 0 : 1;
    emit(signal.aborted ? '自动生成已暂停。已保存的逐字歌词保留，在途请求可能已经计费；未完成项需手动重试。' : `${error instanceof Error ? error.message : '逐字歌词生成失败。'} 本轮已停止，可点击下方“重试未完成项”继续。`);
  } finally { state.running = false; options.progress({ ...state }); }
  return state;
}
