import type { AIConfig, AudioAIRequest, Track } from '../types';
import { alignSpeechWords, readSpeechWords, validateAudioAI, type AlignmentResult } from './audioAlignment';

export const audioUploadLimit = 24 * 1024 * 1024;
const audioFormats: Record<string, string> = { mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', flac: 'audio/flac', ogg: 'audio/ogg' };

export async function prepareAlignmentAudio(track: Pick<Track, 'audio' | 'format'>, signal: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string; type: string }> {
  signal.throwIfAborted();
  if (track.audio.size > 160 * 1024 * 1024) throw new Error('这首音频超过当前识别准备大小，请先转为较小的 MP3；原音频不会被修改。');
  const input = await track.audio.arrayBuffer();
  signal.throwIfAborted();
  const extension = track.format.toLowerCase();
  if (input.byteLength <= audioUploadLimit && audioFormats[extension]) return { bytes: new Uint8Array(input), filename: `song.${extension}`, type: audioFormats[extension] };
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(input);
    signal.throwIfAborted();
    const length = Math.ceil(audio.duration * 16000);
    if (44 + length * 2 > audioUploadLimit) throw new Error('转换后音频仍超过上传上限，请先拆分长音频；未调用音频服务。');
    const renderer = new OfflineAudioContext(1, length, 16000);
    const source = renderer.createBufferSource(); source.buffer = audio; source.connect(renderer.destination); source.start();
    const mono = (await renderer.startRendering()).getChannelData(0);
    signal.throwIfAborted();
    return { bytes: monoWav(mono, 16000), filename: 'song.wav', type: 'audio/wav' };
  } finally { await context.close(); }
}

export function monoWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(output.buffer);
  const text = (position: number, value: string) => { for (let i = 0; i < value.length; i++) output[position + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, output.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  return output;
}

export async function requestAudioAI(request: AudioAIRequest, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (window.tingyuDesktop?.requestAudioAI) {
    const bridge = window.tingyuDesktop;
    const cancel = () => { void bridge.cancelAudioAI(request.id).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try { const result = await bridge.requestAudioAI(request); signal.throwIfAborted(); return result; }
    finally { signal.removeEventListener('abort', cancel); }
  }
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(request.bytes)], { type: request.type }), request.filename);
  form.append('model', request.model); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
  if (request.language) form.append('language', request.language);
  if (request.prompt) form.append('prompt', request.prompt);
  const response = await fetch(request.url, { method: 'POST', headers: { Authorization: `Bearer ${request.key}` }, body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`音频识别失败（HTTP ${response.status}）。请检查服务是否支持音频时间戳、识别模型和余额；本轮未自动重试。`);
  return response.json();
}

export async function generateWordAlignment(track: Track, config: AIConfig, signal: AbortSignal, options: { stage?(message: string): void; request?: typeof requestAudioAI; prepare?: typeof prepareAlignmentAudio } = {}): Promise<AlignmentResult> {
  const url = validateAudioAI(config);
  options.stage?.('正在准备当前歌曲的识别音频…');
  const audio = await (options.prepare || prepareAlignmentAudio)(track, signal);
  signal.throwIfAborted();
  options.stage?.('正在识别音频的字词时间；请求可能计费…');
  const result = await (options.request || requestAudioAI)({ id: crypto.randomUUID(), url, key: config.key, model: config.audioModel?.trim() || 'whisper-1', ...audio, prompt: track.lyrics.map((line) => line.text).join('\n').slice(0, 2500) }, signal);
  signal.throwIfAborted();
  options.stage?.('正在把识别时间与现有原文逐句匹配…');
  return alignSpeechWords(track.lyrics, readSpeechWords(result, track.duration));
}
