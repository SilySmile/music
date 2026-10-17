import type { AudioAIRequest, ForcedAlignConfig, Track } from '../types';
import { prepareAlignmentAudio, requestAudioAI } from './audioAI';
import { type AlignmentResult, vocalLine } from './audioAlignment';
import { singingEnd, timedWords } from './lyricTiming';
import { singingUnits } from './textAlignment';

export const defaultForcedConfig: ForcedAlignConfig = { url: 'http://127.0.0.1:8765/v1', model: 'qwen3-forced-aligner', key: '', automatic: false, concurrency: 2 };
export function readForcedConfig(value: Partial<ForcedAlignConfig> = {}): ForcedAlignConfig {
  return { url: typeof value.url === 'string' ? value.url : defaultForcedConfig.url, model: typeof value.model === 'string' ? value.model : defaultForcedConfig.model, key: typeof value.key === 'string' ? value.key : '', automatic: value.automatic === true, concurrency: value.concurrency === 1 ? 1 : 2 };
}
export function forcedUrl(value: string, endpoint = 'alignments') {
  const url = new URL(value.trim());
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new Error('强对齐地址须为 HTTPS，或本机 http://127.0.0.1 地址；不能包含密码或参数。');
  const base = url.pathname.replace(/\/(alignments|health|models)\/?$/, '').replace(/\/+$/, '');
  url.pathname = `${base || '/v1'}/${endpoint}`;
  return url.href;
}
export type ForcedHealth = { service: 'xianqiji-forced-aligner'; protocol: 1; model: string; ready: boolean; resource_ready: boolean; reason?: string; concurrency: number };
export async function checkForcedAlignment(config: Pick<ForcedAlignConfig, 'url' | 'key' | 'model'>, signal?: AbortSignal): Promise<ForcedHealth> {
  forcedUrl(config.url, 'health');
  let value: ForcedHealth;
  if (window.tingyuDesktop?.checkForcedAlignment) {
    try { value = await window.tingyuDesktop.checkForcedAlignment(config); }
    catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '连接不可用';
      throw new Error(/ERR_CONNECTION|ERR_NETWORK|Failed to fetch/i.test(message) ? '无法连接本地强对齐服务，请先启动模型，再检查地址。' : message);
    }
  }
  else {
    const response = await fetch(forcedUrl(config.url, 'health'), { headers: { Authorization: `Bearer ${config.key}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000), redirect: 'error', credentials: 'omit' });
    if (!response.ok) throw new Error(`强对齐连接失败（HTTP ${response.status}），请检查服务和本地密钥。`);
    value = await response.json();
  }
  signal?.throwIfAborted();
  if (value.service !== 'xianqiji-forced-aligner' || value.protocol !== 1 || value.model !== config.model) throw new Error('服务协议或模型名称不匹配，请导入本地服务生成的连接配置。');
  return value;
}
export const needsForcedAlignment = (track: Pick<Track, 'lyrics'>) => track.lyrics.some((line) => vocalLine(line) && (!timedWords(line) || line.wordTiming === 'estimated'));
export function forcedTargets(track: Pick<Track, 'lyrics' | 'duration'>, lineIds?: number[]) {
  return track.lyrics.flatMap((line, id) => {
    if ((lineIds && !lineIds.includes(id)) || !vocalLine(line) || (timedWords(line) && line.wordTiming !== 'estimated') || line.time < 0) return [];
    const boundary = Math.min(track.duration, track.lyrics.slice(id + 1).find((next) => next.time >= line.time)?.time ?? track.duration);
    const end = line.wordTiming === 'estimated' ? boundary : singingEnd(line, boundary);
    return Number.isFinite(end) && end > line.time ? [{ id, text: line.text, start: line.time, end, units: singingUnits(line.text) }] : [];
  });
}
export async function generateForcedAlignment(track: Track, config: ForcedAlignConfig, signal: AbortSignal, options: { lineIds?: number[]; stage?(message: string): void; request?: typeof requestAudioAI; prepare?: typeof prepareAlignmentAudio } = {}): Promise<AlignmentResult> {
  const targets = forcedTargets(track, options.lineIds);
  if (!targets.length) return { lyrics: track.lyrics, matched: 0, unmatched: 0, existing: track.lyrics.filter((line) => !!timedWords(line)).length };
  if (!config.key.trim() || !config.model.trim()) throw new Error('请先配置强对齐服务地址、模型名称和本地服务密钥。');
  options.stage?.('正在向强对齐服务提交音频与原歌词…');
  const audio = await (options.prepare || prepareAlignmentAudio)(track, signal);
  signal.throwIfAborted();
  const data = await (options.request || requestAudioAI)({ id: crypto.randomUUID(), url: forcedUrl(config.url), key: config.key, model: config.model, ...audio, alignment: { trackId: track.id, duration: track.duration, lines: targets } }, signal) as { protocol?: number; model?: string; trackId?: string; lines?: { id: number; text: string; words?: { text: string; start: number; end: number }[]; error?: string }[] };
  signal.throwIfAborted();
  if (data.protocol !== 1 || data.model !== config.model || data.trackId !== track.id || !Array.isArray(data.lines)) throw new Error('强对齐返回的歌曲、模型或协议不匹配，原歌词保留。');
  const lyrics = [...track.lyrics]; const seen = new Set<number>(); let matched = 0;
  for (const item of data.lines) {
    const target = targets.find((line) => line.id === item?.id);
    if (!target || seen.has(target.id) || item.text !== target.text) throw new Error('强对齐改动了原歌词或行号，原歌词保留。');
    seen.add(target.id);
    if (item.error || !Array.isArray(item.words) || item.words.length !== target.units.length) continue;
    let previous = target.start;
    const valid = item.words.every((word, index) => {
      const ok = word.text === target.units[index] && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= previous && word.end > word.start && word.end <= target.end + .001;
      previous = word.end; return ok;
    });
    if (!valid) continue;
    const words = item.words.map((word) => ({ text: word.text, time: word.start, endTime: word.end }));
    lyrics[target.id] = { ...lyrics[target.id], words, endTime: words.at(-1)!.endTime, wordTiming: undefined, timingNote: undefined }; matched++;
  }
  return { lyrics, matched, unmatched: targets.length - matched, existing: track.lyrics.length - targets.length };
}
