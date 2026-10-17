import { sha256 } from '@noble/hashes/sha2.js';
import type { Track } from '../types';
import { timedWords, wordTimingMetadata } from './lyricTiming';
import { listSource, sourceRequest, uploadSourceTrack, type SourceConfig, type SourceInfo, type SourceRequester, type SourceTrack } from './onlineSource';

export type SourceSyncIssue = { id: string; title: string; reason: string };
export type SourceSyncState = { enabled: boolean; running: boolean; message: string; total: number; checked: number; uploaded: number; unchanged: number; conflicts: number; errors: number; issues: SourceSyncIssue[]; finishedAt?: number };
export const emptySourceSync: SourceSyncState = { enabled: false, running: false, message: '', total: 0, checked: 0, uploaded: 0, unchanged: 0, conflicts: 0, errors: 0, issues: [] };
type Baseline = { local: string; remote: string; revision: number };
type Verification = { id: string; revision: number; ok: boolean; media: { audio: boolean; cover?: boolean } };
const digest = (value: string) => Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const normalizedLyrics = (track: Pick<Track, 'lyrics'>) => track.lyrics.map((line) => ({ time: Math.round(line.time * 100), text: line.text.trim(), translation: line.translation?.trim() || '', ...(timedWords(line) ? { words: line.words, ...wordTimingMetadata(line) } : {}) }));
function semantic(track: Omit<Track, 'audio' | 'cover'>, cover?: string) {
  return { title: track.title.trim(), artist: track.artist.trim(), album: track.album.trim(), lyrics: normalizedLyrics(track), cover: cover || '' };
}
export function sourceSyncTrigger(tracks: Track[]) {
  return digest(JSON.stringify(tracks.map((track) => [track.id, semantic(track), track.cover?.size, track.audio.size])));
}
export function sourceSyncKey(config: SourceConfig, scope: string, id: string) {
  return `xianqiji-source-baseline:${digest(JSON.stringify([config.baseUrl, config.token, scope]))}:${id}`;
}
async function coverDigest(cover: Blob | undefined, signal: AbortSignal) {
  if (!cover) return undefined;
  const hash = sha256.create();
  for (let offset = 0; offset < cover.size; offset += 1024 * 1024) { signal.throwIfAborted(); hash.update(new Uint8Array(await cover.slice(offset, offset + 1024 * 1024).arrayBuffer())); }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function remoteFingerprint(record: SourceTrack) { return digest(JSON.stringify(semantic(record.metadata, record.cover?.sha256))); }

export function planSourceUpload(local: Track, cover: string | undefined, remote: SourceTrack | undefined, baseline?: Baseline): { action: 'upload' | 'skip' | 'conflict'; track: Track; reason?: string } {
  if (!remote) return { action: 'upload', track: local };
  const localFingerprint = digest(JSON.stringify(semantic(local, cover)));
  const remoteSignature = remoteFingerprint(remote);
  if (localFingerprint === remoteSignature) return { action: 'skip', track: local };
  if (baseline && baseline.revision === remote.revision && baseline.remote === remoteSignature) {
    if (baseline.local === localFingerprint) return { action: 'skip', track: local };
    if (baseline.local === baseline.remote) return { action: 'upload', track: local };
  }
  const conflict = (reason: string) => ({ action: 'conflict' as const, track: local, reason });
  for (const key of ['title', 'artist', 'album'] as const) {
    if (local[key].trim() && remote.metadata[key].trim() && local[key].trim() !== remote.metadata[key].trim()) return conflict('本地和线上歌曲信息不同，请核对后手动上传或下载。');
  }
  if (cover && remote.cover && cover !== remote.cover.sha256) return conflict('两端封面不同，已保留两端内容，请手动选择。');
  let lyrics = local.lyrics;
  if (remote.metadata.lyrics.length && local.lyrics.length) {
    const localLines = normalizedLyrics(local); const remoteLines = normalizedLyrics(remote.metadata);
    if (localLines.length !== remoteLines.length || localLines.some((line, index) => line.time !== remoteLines[index].time || line.text !== remoteLines[index].text)) return conflict('两端原文歌词或时间轴不同，未自动覆盖。');
    if (localLines.some((line, index) => line.translation && remoteLines[index].translation && line.translation !== remoteLines[index].translation)) return conflict('两端已有不同中文译文，未自动覆盖。');
    if (localLines.some((line, index) => line.words && remoteLines[index].words && JSON.stringify(line.words) !== JSON.stringify(remoteLines[index].words))) return conflict('两端逐字时间轴不同，未自动覆盖。');
    lyrics = local.lyrics.map((line, index) => ({ ...line, ...(!timedWords(line) && timedWords(remote.metadata.lyrics[index]) ? { words: remote.metadata.lyrics[index].words, ...wordTimingMetadata(remote.metadata.lyrics[index]) } : {}), translation: line.translation || remote.metadata.lyrics[index].translation }));
  } else if (!lyrics.length) lyrics = remote.metadata.lyrics;
  const merged = { ...local, title: local.title || remote.metadata.title, artist: local.artist || remote.metadata.artist, album: local.album || remote.metadata.album, lyrics };
  const mergedFingerprint = digest(JSON.stringify(semantic(merged, cover || remote.cover?.sha256)));
  return { action: mergedFingerprint === remoteSignature ? 'skip' : 'upload', track: merged };
}

export async function runSourceAutoSync(options: { tracks: Track[]; config: SourceConfig; scope: string; signal: AbortSignal; progress(state: SourceSyncState): void; request?: SourceRequester; upload?: typeof uploadSourceTrack; storage?: Pick<Storage, 'getItem' | 'setItem'> }) {
  const { tracks, config, scope, signal, progress } = options;
  const request = options.request || sourceRequest;
  const upload = options.upload || uploadSourceTrack;
  const storage = options.storage || localStorage;
  const state: SourceSyncState = { ...emptySourceSync, enabled: true, running: true, total: tracks.length, issues: [], message: '正在连接并核对线上曲库…' };
  const emit = (message: string) => { state.message = message; progress({ ...state, issues: [...state.issues] }); };
  signal.throwIfAborted(); emit(state.message);
  const info = await request<SourceInfo>({ method: 'GET', path: '/info' }, signal);
  if (info.product !== 'xianqiji-online-library' || info.schema !== 1 || info.chunkBytes !== 1024 * 1024 || !info.verification) throw new Error('服务器尚不支持自动核验，请先更新在线曲库服务。');
  if (!info.canWrite) throw new Error('此密钥只有读取权限；自动上传需要读写密钥。');
  const remote = new Map((await listSource(request, signal)).map((record) => [record.metadata.id, record]));
  let networkFailures = 0;
  for (const track of tracks) {
    signal.throwIfAborted(); emit(`核对 ${state.checked + 1} / ${tracks.length} · ${track.title}`);
    state.checked += 1;
    try {
      const key = sourceSyncKey(config, scope, track.id);
      let baseline: Baseline | undefined;
      try { const value = JSON.parse(storage.getItem(key) || 'null'); if (value && /^[a-f0-9]{64}$/.test(value.local) && /^[a-f0-9]{64}$/.test(value.remote) && Number.isSafeInteger(value.revision)) baseline = value; } catch { baseline = undefined; }
      const cover = await coverDigest(track.cover, signal);
      let record = remote.get(track.id);
      const plan = planSourceUpload(track, cover, record, baseline);
      if (plan.action === 'conflict') {
        state.conflicts += 1;
        if (state.issues.length < 100) state.issues.push({ id: track.id, title: track.title, reason: plan.reason! });
      } else {
        let valid = true;
        if (record) {
          const verified = await request<Verification>({ method: 'GET', path: `/tracks/${track.id}/verify` }, signal);
          if (verified.id !== track.id || verified.revision !== record.revision || typeof verified.ok !== 'boolean' || typeof verified.media?.audio !== 'boolean' || record.cover && typeof verified.media.cover !== 'boolean' || verified.ok !== (verified.media.audio && (!record.cover || verified.media.cover === true))) throw new Error('线上校验结果或修订号变化，请等待下一轮核对。');
          valid = verified.ok;
          if (!valid && record.cover && verified.media.cover === false && (!track.cover || cover !== record.cover.sha256)) throw new Error('线上封面损坏，但本机没有对应原文件，无法自动修复。');
        }
        if (plan.action === 'upload' || !valid) {
          record = await upload(plan.track, record?.revision || 0, config, emit, signal, request);
          const verified = await request<Verification>({ method: 'GET', path: `/tracks/${track.id}/verify` }, signal);
          if (verified.id !== track.id || verified.revision !== record.revision || verified.ok !== true) throw new Error('上传后线上 SHA-256 核验未通过，请检查服务器。');
          state.uploaded += 1;
        } else state.unchanged += 1;
        if (record) storage.setItem(key, JSON.stringify({ local: digest(JSON.stringify(semantic(track, cover))), remote: remoteFingerprint(record), revision: record.revision } satisfies Baseline));
      }
      networkFailures = 0;
    } catch (error) {
      signal.throwIfAborted();
      const status = (error as { status?: number }).status;
      if ([401, 403, 507].includes(status || 0)) throw error;
      if (status === 409) state.conflicts += 1; else state.errors += 1;
      if (state.issues.length < 100) state.issues.push({ id: track.id, title: track.title, reason: error instanceof Error ? error.message : '核验 / 上传失败，下轮重试。' });
      if (status === 0 || status && status >= 500 || error instanceof Error && /fetch|network|timeout|socket|connection|网络|超时/i.test(error.message)) networkFailures += 1; else networkFailures = 0;
      if (networkFailures >= 3) { emit('多次网络异常，已暂停本轮；联网后自动重试。'); break; }
    }
  }
  signal.throwIfAborted();
  state.running = false; state.finishedAt = Date.now();
  emit(`已核对 ${state.checked} / ${tracks.length} 首 · 上传 ${state.uploaded} · 相同 / 已保留线上 ${state.unchanged} · 待核对 ${state.conflicts} · 失败 ${state.errors}`);
  return state;
}
