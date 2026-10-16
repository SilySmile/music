import { sha256 } from '@noble/hashes/sha2.js';
import type { Track } from '../types';
import type { ExportEntry, ExportTask, ImportTask } from './transferTypes';
import { commitImportedTrack, getTrack, saveTransfer } from './storage';
import { importFiles } from './importer';
import { safeFilename, serializeLyrics } from './exporter';
import { initialZipCheckpoint, runZipCheckpoint } from './zipCheckpoint';
import { openTransferWriter } from './transferWriter';

export async function filesFingerprint(files: File[]) {
  const digest = sha256.create();
  const encoder = new TextEncoder();
  for (const file of [...files].sort((first, second) => (first.webkitRelativePath || first.name).localeCompare(second.webkitRelativePath || second.name))) {
    digest.update(encoder.encode(`${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}|`));
    digest.update(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
    if (file.size > 65536) digest.update(new Uint8Array(await file.slice(-65536).arrayBuffer()));
  }
  return Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createImportTask(files: File[]): Promise<ImportTask> {
  const task: ImportTask = { id: crypto.randomUUID(), kind: 'import', label: files.length === 1 ? files[0].name : `${files.length} 个音乐文件`, fingerprint: await filesFingerprint(files), completed: [], total: 0, status: 'paused', updatedAt: Date.now(), warnings: [] };
  await saveTransfer(task);
  return task;
}

export async function runImportTask(task: ImportTask, files: File[], signal: AbortSignal, onProgress: (message: string) => void) {
  if (await filesFingerprint(files) !== task.fingerprint) throw new Error('文件与这个任务不一致，请重新选择原音乐包（多文件导入需全部选择）。');
  task.status = 'running'; task.error = undefined; task.updatedAt = Date.now();
  await saveTransfer(task);
  try {
    const result = await importFiles(files, onProgress, {
      signal, completed: new Set(task.completed), collect: false,
      onTotal: async (total) => { task.total = total; await saveTransfer(task); },
      onTrack: async (track, entry) => { await commitImportedTrack(track, task, entry); },
    });
    task.warnings = result.warnings;
    task.status = task.completed.length === task.total ? 'completed' : 'failed';
    if (task.status === 'failed') task.error = result.warnings[0] || '部分文件未完成，可以继续重试失败项。';
  } catch (error) {
    task.status = signal.aborted ? 'paused' : 'failed';
    task.error = signal.aborted ? undefined : error instanceof Error ? error.message : '导入中断，进度已保留。';
  }
  task.updatedAt = Date.now(); await saveTransfer(task);
  return task;
}

export async function createExportTask(tracks: Track[]): Promise<ExportTask> {
  if (!tracks.length) throw new Error('请先选择要导出的歌曲。');
  const entries: ExportEntry[] = [];
  const addText = (name: string, text: string) => entries.push({ name, size: new TextEncoder().encode(text).length, source: { type: 'text', text } });
  for (const [index, track] of tracks.entries()) {
    const base = safeFilename(`${track.artist} - ${track.title}`);
    const directory = `${String(index + 1).padStart(3, '0')} - ${safeFilename(track.title)} - ${track.id.slice(0, 8)}`;
    const extension = /^[a-z0-9]{2,5}$/i.test(track.format) ? track.format.toLowerCase() : 'mp3';
    entries.push({ name: `${directory}/${base}.${extension}`, size: track.audio.size, source: { type: 'audio', trackId: track.id } });
    if (track.cover) entries.push({ name: `${directory}/cover.${track.cover.type === 'image/png' ? 'png' : track.cover.type === 'image/webp' ? 'webp' : 'jpg'}`, size: track.cover.size, source: { type: 'cover', trackId: track.id } });
    const timed = track.lyrics.some((line) => line.time >= 0);
    if (track.lyrics.length) addText(`${directory}/${base}.${timed ? 'lrc' : 'txt'}`, serializeLyrics(track.lyrics));
    if (track.lyrics.some((line) => line.translation)) addText(`${directory}/${base}.zh.${timed ? 'lrc' : 'txt'}`, serializeLyrics(track.lyrics, true));
    const { audio: _audio, cover: _cover, ...metadata } = track;
    addText(`${directory}/tingyu-library.json`, JSON.stringify({ format: 'xianqiji-library', version: 1, tracks: [metadata] }));
  }
  addText('导入说明.txt', '在弦栖霁中导入整个 ZIP 即可恢复歌曲、封面、歌词、译文与收藏。兼容原听屿音乐包；本包不含 API Key。');
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const task: ExportTask = { id: crypto.randomUUID(), kind: 'export', label: `${tracks.length} 首歌曲`, filename: `弦栖霁-${stamp}-${tracks.length}首.zip`, entries, checkpoint: initialZipCheckpoint(), status: 'paused', updatedAt: Date.now() };
  await saveTransfer(task);
  return task;
}

export async function runExportTask(task: ExportTask, signal: AbortSignal, onProgress: (message: string) => void) {
  task.status = 'running'; task.error = undefined;
  await saveTransfer(task);
  let writer: Awaited<ReturnType<typeof openTransferWriter>> | undefined;
  try {
    writer = await openTransferWriter(task);
    task.location = writer.location;
    let currentTrack: Track | undefined;
    const checkpoint = await runZipCheckpoint(task.entries, task.checkpoint, {
      signal,
      read: async (entry, offset, length) => {
        if (entry.source.type === 'text') return new TextEncoder().encode(entry.source.text).slice(offset, offset + length);
        if (currentTrack?.id !== entry.source.trackId) currentTrack = await getTrack(entry.source.trackId);
        const blob = entry.source.type === 'audio' ? currentTrack?.audio : currentTrack?.cover;
        if (!blob || blob.size !== entry.size) throw new Error('源歌曲或封面已移除，无法继续这个任务。请恢复源文件后继续。');
        return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      },
      write: writer.write,
      save: async (next) => { const updated = { ...task, checkpoint: next, updatedAt: Date.now() }; await saveTransfer(updated); task.checkpoint = next; task.updatedAt = updated.updatedAt; },
      onProgress: (next) => onProgress(`已写入 ${(next.offset / 1024 / 1024).toFixed(1)} MB · 文件 ${Math.min(next.entryIndex + 1, task.entries.length)} / ${task.entries.length}`),
    });
    task.location = await writer.finish(checkpoint.offset);
    task.status = 'completed';
  } catch (error) {
    task.status = signal.aborted ? 'paused' : 'failed';
    task.error = signal.aborted ? undefined : error instanceof Error ? error.message : '导出中断，分块进度已保存。';
  } finally { await writer?.close(); }
  task.updatedAt = Date.now(); await saveTransfer(task);
  return task;
}
