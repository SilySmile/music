import { sha256 } from '@noble/hashes/sha2.js';
import { beginBackgroundTask } from './backgroundTasks';
import { getTrack, invalidateLibraryTracks, saveTransfer, sourceLibraryScope } from './storage';
import { downloadSourceTrack, listSource, loadSourceConfig, normalizeSourceUrl, sourceRequest, uploadSourceTrack, type SourceConfig, type SourceRequester } from './onlineSource';
import type { SourceTransferTask } from './transferTypes';
import type { Track } from '../types';
import { nativeSourceDownloads, nativeSourceEnabled, validNativeSourceTask } from './nativeSourceDownloads';

export function sourceIdentity(config: SourceConfig) {
  return Array.from(sha256(new TextEncoder().encode(`${normalizeSourceUrl(config.baseUrl)}|${config.token}`)), (value) => value.toString(16).padStart(2, '0')).join('');
}
export async function createSourceTransfer(direction: SourceTransferTask['direction'], ids: string[], config: SourceConfig): Promise<SourceTransferTask> {
  if (!ids.length) throw new Error('请先选择歌曲。');
  const task: SourceTransferTask = { id: crypto.randomUUID(), kind: 'source', direction, label: `${direction === 'upload' ? '上传到线上' : '下载 / 补充到本地'} · ${new Set(ids).size} 首`, sourceIdentity: sourceIdentity(config), scope: await sourceLibraryScope(), ids: [...new Set(ids)], completed: [], status: 'paused', updatedAt: Date.now() };
  await saveTransfer(task); return task;
}
export async function runSourceTransfer(task: SourceTransferTask, signal: AbortSignal, onProgress: (message: string) => void, onSaved: (track: Track) => Promise<void> = async () => {}) {
  const job = await beginBackgroundTask({ id: task.id, title: task.label, view: 'settings', signal, persistent: true });
  const progress = (message: string) => { job.progress(message); onProgress(message); };
  task.status = 'running'; task.error = undefined;
  try {
    const config = await loadSourceConfig();
    const guard = async () => {
      job.signal.throwIfAborted();
      if (task.scope !== await sourceLibraryScope()) throw new Error('任务属于另一音乐库，请切回原库后继续。');
      if (task.sourceIdentity !== sourceIdentity(await loadSourceConfig())) throw new Error('音源地址或密钥已改变，请恢复原连接后继续这个任务。');
    };
    await guard(); await saveTransfer({ ...task, updatedAt: Date.now() });
    if (task.direction === 'download' && nativeSourceEnabled(task.scope)) {
      const listener = await nativeSourceDownloads.addListener('sourceProgress', (next) => { if (next.id === task.id && validNativeSourceTask(next)) { task.completed = [...next.completed]; progress(next.progress || `原生后台已完成 ${next.completed.length} / ${next.ids.length} 首`); } });
      const pause = () => { void nativeSourceDownloads.pauseSource({ id: task.id }).catch(() => {}); };
      job.signal.addEventListener('abort', pause, { once: true });
      try {
        job.signal.throwIfAborted();
        const result = await nativeSourceDownloads.downloadSource({ task, baseUrl: normalizeSourceUrl(config.baseUrl), token: config.token });
        if (!validNativeSourceTask(result) || result.id !== task.id || result.scope !== task.scope || result.sourceIdentity !== task.sourceIdentity || JSON.stringify(result.ids) !== JSON.stringify(task.ids)) throw new Error('原生下载返回的音乐库或歌曲清单不符，请检查任务中心。');
        Object.assign(task, result); invalidateLibraryTracks(task.completed);
        for (const id of task.completed) { const saved = await getTrack(id); if (saved) await onSaved(saved); }
        progress(result.status === 'completed' ? `下载 / 补充完成：${task.completed.length} 首，已写入当前本地音乐库。` : task.error || `已暂停，已保存 ${task.completed.length} 首。`);
        return task;
      } finally { job.signal.removeEventListener('abort', pause); await listener.remove(); }
    }
    const request: SourceRequester = async (request, signal) => { await guard(); return sourceRequest(request, signal); };
    const remote = task.direction === 'download' ? new Map((await listSource(request, job.signal)).map((record) => [record.metadata.id, record])) : undefined;
    for (const id of task.ids) {
      if (task.completed.includes(id)) continue;
      await guard(); progress(`已完成 ${task.completed.length} / ${task.ids.length} 首 · 正在${task.direction === 'upload' ? '上传' : '下载 / 补充'}`);
      if (task.direction === 'upload') {
        const track = await getTrack(id); if (!track) throw new Error('本地歌曲已改变，请核对后重试。');
        await uploadSourceTrack(track, 0, config, progress, job.signal, request);
      } else {
        const record = remote!.get(id); if (!record) throw new Error('线上歌曲已不可用，请刷新核对。');
        const saved = await downloadSourceTrack(record, progress, job.signal, request);
        await onSaved(saved);
      }
      task.completed = [...new Set([...task.completed, id])]; task.updatedAt = Date.now(); await saveTransfer(task);
    }
    task.status = 'completed'; progress(`${task.direction === 'upload' ? '上传' : '下载 / 补充'}完成：${task.completed.length} 首。`);
  } catch (error) {
    task.status = job.signal.aborted ? 'paused' : 'failed';
    task.error = job.signal.aborted ? undefined : error instanceof Error ? error.message : '传输失败，请核对后重试。';
    progress(`已完成 ${task.completed.length} 首。${job.signal.aborted ? '已暂停，已完成歌曲保留，可在任务中心继续；当前未完成歌曲重新校验。' : task.error}`);
  } finally {
    task.updatedAt = Date.now();
    try { await saveTransfer(task); } finally { await job.finish(task.status, task.error || (task.status === 'completed' ? `${task.label}已完成` : '已暂停，检查点保留。')); }
  }
  return task;
}
