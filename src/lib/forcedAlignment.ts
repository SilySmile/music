import type { AudioAIRequest, ForcedAlignConfig, Track } from '../types';
import { prepareAlignmentAudio, requestAudioAI } from './audioAI';
import { type AlignmentResult, normalizeSpeechText, vocalLine } from './audioAlignment';
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
export type ForcedHealth = { service: 'xianqiji-forced-aligner'; protocol: 1; model: string; ready: boolean; resource_ready: boolean; reason?: string; concurrency: number; alignment_strategies?: number; progress?: { trackId: string; total: number; processed: number; matched: number }[] };
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
function forcedVocalLine(track: Pick<Track, 'title' | 'artist'>, line: Track['lyrics'][number]) {
  if (!vocalLine(line)) return false;
  const text = normalizeSpeechText(line.text);
  // A full title + artist header is metadata; a sung title on its own is not.
  return !(track.title && track.artist && /\s[-–—]\s/.test(line.text) && [track.title + track.artist, track.artist + track.title].some((header) => normalizeSpeechText(header) === text));
}
export const needsForcedAlignment = (track: Pick<Track, 'lyrics' | 'title' | 'artist'>) => track.lyrics.some((line) => forcedVocalLine(track, line) && (!timedWords(line) || line.wordTiming === 'estimated'));
export function forcedTargets(track: Pick<Track, 'lyrics' | 'duration' | 'title' | 'artist'>, lineIds?: number[]) {
  return track.lyrics.flatMap((line, id) => {
    if ((lineIds && !lineIds.includes(id)) || !forcedVocalLine(track, line) || (timedWords(line) && line.wordTiming !== 'estimated') || line.time < 0) return [];
    const boundary = Math.min(track.duration, track.lyrics.slice(id + 1).find((next) => next.time >= line.time)?.time ?? track.duration);
    const end = line.wordTiming === 'estimated' ? boundary : singingEnd(line, boundary);
    return Number.isFinite(end) && end > line.time ? [{ id, text: line.text, start: line.time, end, units: singingUnits(line.text) }] : [];
  });
}
type ForcedOptions = { lineIds?: number[]; stage?(message: string): void; request?: typeof requestAudioAI; prepare?: typeof prepareAlignmentAudio; health?: typeof checkForcedAlignment; round?: number };
export async function generateForcedAlignmentPass(track: Track, config: ForcedAlignConfig, signal: AbortSignal, options: ForcedOptions = {}): Promise<AlignmentResult> {
  const targets = forcedTargets(track, options.lineIds);
  if (!targets.length) return { lyrics: track.lyrics, matched: 0, unmatched: 0, existing: track.lyrics.filter((line) => !!timedWords(line)).length };
  if (!config.key.trim() || !config.model.trim()) throw new Error('请先配置强对齐服务地址、模型名称和本地服务密钥。');
  options.stage?.('正在向强对齐服务提交音频与原歌词…');
  const audio = await (options.prepare || prepareAlignmentAudio)(track, signal);
  signal.throwIfAborted();
  options.stage?.(`本地强对齐：正在检查整首待处理的 ${targets.length} 句…`);
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    try {
      const health = await (options.health || checkForcedAlignment)(config, signal);
      const current = health.progress?.find((item) => item.trackId === track.id);
      if (!finished && !signal.aborted && current && Number.isInteger(current.processed) && Number.isInteger(current.total) && Number.isInteger(current.matched)) options.stage?.(`本地强对齐：已检查 ${current.processed} / ${current.total} 句，通过 ${current.matched} 句；其余继续处理…`);
    } catch { /* Progress is optional; the alignment request reports failures. */ }
    if (!finished && !signal.aborted) timer = setTimeout(() => void poll(), 2000);
  }
  if (options.stage) timer = setTimeout(() => void poll(), 2000);
  let data: { protocol?: number; model?: string; trackId?: string; lines?: { id: number; text: string; words?: { text: string; start: number; end: number }[]; error?: string }[] };
  try {
    data = await (options.request || requestAudioAI)({ id: crypto.randomUUID(), url: forcedUrl(config.url), key: config.key, model: config.model, ...audio, alignment: { trackId: track.id, duration: track.duration, attempt: options.round || 0, lines: targets } }, signal) as typeof data;
  } finally { finished = true; clearTimeout(timer); }
  signal.throwIfAborted();
  if (data.protocol !== 1 || data.model !== config.model || data.trackId !== track.id || !Array.isArray(data.lines)) throw new Error('强对齐返回的歌曲、模型或协议不匹配，原歌词保留。');
  const lyrics = [...track.lyrics]; const seen = new Set<number>(); let matched = 0;
  const issues: NonNullable<AlignmentResult['issues']> = [];
  for (const item of data.lines) {
    const target = targets.find((line) => line.id === item?.id);
    if (!target || seen.has(target.id) || item.text !== target.text) throw new Error('强对齐改动了原歌词或行号，原歌词保留。');
    seen.add(target.id);
    if (item.error || !Array.isArray(item.words) || item.words.length !== target.units.length) {
      issues.push({ line: target.id + 1, reason: typeof item.error === 'string' ? item.error.slice(0, 240) : '返回的字词数量不完整' }); continue;
    }
    let previous = target.start;
    const valid = item.words.every((word, index) => {
      const ok = word.text === target.units[index] && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= previous && word.end > word.start && word.end <= target.end + .001;
      previous = word.end; return ok;
    });
    if (!valid) { issues.push({ line: target.id + 1, reason: '返回的字词与原文不符，或时间交叉、越过原句范围' }); continue; }
    const words = item.words.map((word) => ({ text: word.text, time: word.start, endTime: word.end }));
    lyrics[target.id] = { ...lyrics[target.id], words, endTime: words.at(-1)!.endTime, wordTiming: undefined, timingNote: undefined }; matched++;
  }
  for (const target of targets) if (!seen.has(target.id)) issues.push({ line: target.id + 1, reason: '服务未返回本句的对齐结果' });
  return { lyrics, matched, unmatched: targets.length - matched, existing: track.lyrics.length - targets.length, issues };
}

export async function generateForcedAlignment(track: Track, config: ForcedAlignConfig, signal: AbortSignal, options: ForcedOptions = {}): Promise<AlignmentResult> {
  const targets = forcedTargets(track, options.lineIds);
  let result: AlignmentResult = { lyrics: track.lyrics, matched: 0, unmatched: targets.length, existing: track.lyrics.length - targets.length, rounds: 0 };
  if (!targets.length) return result;
  let audio: ReturnType<typeof prepareAlignmentAudio> | undefined;
  const prepare: typeof prepareAlignmentAudio = (source, abort) => audio ||= (options.prepare || prepareAlignmentAudio)(source, abort);
  const health = options.health || checkForcedAlignment;
  for (let round = 0; round < 5; round++) {
    signal.throwIfAborted();
    try {
      if (round) {
        const status = await health(config, signal);
        if (!status.ready || !status.resource_ready) {
          result.interrupted = true; options.stage?.(`本地强对齐已暂停：${status.reason || '资源暂不可用'}；已通过 ${result.matched} 句，剩余 ${result.unmatched} 句。`); break;
        }
        if ((status.alignment_strategies || 1) <= round) {
          result.issues = [...(result.issues || []), { line: targets[0].id + 1, reason: '当前服务不支持更多音频上下文，请更新并重启本地模型服务' }]; break;
        }
      }
      const next = await generateForcedAlignmentPass({ ...track, lyrics: result.lyrics }, config, signal, { ...options, round, prepare, stage: (message) => options.stage?.(`第 ${round + 1} 轮 · 已通过 ${result.matched} 句，剩余 ${result.unmatched} 句 · ${message}`) });
      result = { ...next, matched: result.matched + next.matched, unmatched: targets.length - result.matched - next.matched, existing: result.existing, rounds: round + 1 };
      if (!result.unmatched) break;
      // A different crop cannot fix a malformed or overlong source interval.
      if (next.issues?.length && next.issues.every((issue) => /区间超过 60 秒|超出音频|原句区间太短|已尝试相同音频范围/.test(issue.reason))) break;
    } catch (error) {
      if (signal.aborted || !result.matched || !/503|429|fetch|连接|ECONN|Failed to fetch/i.test(error instanceof Error ? error.message : '')) throw error;
      result.interrupted = true; break;
    }
  }
  signal.throwIfAborted();
  return result;
}

export function alignmentIssueSummary(issues?: AlignmentResult['issues']) {
  return issues?.length ? ` 原因：${issues.slice(0, 3).map((issue) => `第 ${issue.line} 句：${issue.reason}`).join('；')}${issues.length > 3 ? `；另有 ${issues.length - 3} 句，可选中单句重试查看。` : '。'}` : '';
}
