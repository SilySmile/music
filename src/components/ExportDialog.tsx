import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Download, LoaderCircle, X } from 'lucide-react';
import type { Track } from '../types';
import { createExportTask, runExportTask } from '../lib/transfers';
import { presentExport } from '../lib/transferWriter';
import type { ExportTask } from '../lib/transferTypes';
import { getTransfers } from '../lib/storage';

export default function ExportDialog({ tracks, currentId, onClose, onTasks, onBusy, foreground = true }: { tracks: Track[]; currentId: string; onClose(): void; onTasks(): void; onBusy(value: boolean): void; foreground?: boolean }) {
  const [selected, setSelected] = useState(() => new Set(tracks.map((track) => track.id)));
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [task, setTask] = useState<ExportTask | null>(null);
  const [status, setStatus] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const chosen = useMemo(() => tracks.filter((track) => selected.has(track.id)), [tracks, selected]);
  const bytes = chosen.reduce((total, track) => total + track.audio.size + (track.cover?.size ?? 0), 0);
  async function exportMusic() {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setStatus('正在准备音乐包…');
    controllerRef.current = new AbortController();
    try {
      const next = task ? (await getTransfers()).find((saved): saved is ExportTask => saved.kind === 'export' && saved.id === task.id) ?? task : await createExportTask(chosen);
      setTask(next);
      if (next.status === 'completed') { setStatus(`导出已完成：${next.location}`); return; }
      const result = await runExportTask(next, controllerRef.current.signal, setStatus);
      setTask({ ...result });
      setStatus(result.status === 'completed' ? `导出完成：${result.location}。新设备导入此 ZIP 即可恢复。` : result.error || '已暂停，写入进度已保存，重启后可在传输任务中继续。');
    } catch (error) { setStatus(controllerRef.current.signal.aborted ? '已取消导出，音乐库不受影响。' : error instanceof Error ? error.message : '导出失败，请检查存储空间。'); }
    finally { lock.current = false; setBusy(false); onBusy(false); setWriting(false); }
  }
  return <div className="modal-backdrop"><section className="modal export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-heading"><div><span className="eyebrow">TAKE YOUR MUSIC WITH YOU</span><h2 id="export-title">把音乐带到下一台设备</h2></div><button className="icon-button" title={busy ? '后台继续导出' : '关闭'} onClick={onClose} aria-label="关闭音乐导出"><X size={20} /></button></div><div className="export-summary"><Archive size={29} /><div><strong>已选 {chosen.length} 首 · 约 {(bytes / 1024 / 1024).toFixed(1)} MB</strong><p>原始音频 + 封面 + 双语歌词 + 收藏记录</p></div></div><div className="export-presets"><button disabled={busy || !!task} onClick={() => setSelected(new Set(tracks.map((track) => track.id)))}>全部选择</button><button disabled={busy || !!task} onClick={() => setSelected(new Set(tracks.filter((track) => track.favorite).map((track) => track.id)))}>仅收藏</button><button disabled={busy || !!task || !currentId} onClick={() => setSelected(new Set([currentId]))}>当前歌曲</button><button disabled={busy || !!task} onClick={() => setSelected(new Set())}>清空选择</button></div><div className="export-track-list">{foreground && tracks.map((track) => <label key={track.id}><input aria-label={`导出 ${track.title}`} type="checkbox" disabled={busy || !!task} checked={selected.has(track.id)} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(track.id); else next.delete(track.id); return next; })} /><span><strong>{track.title}</strong><small>{track.artist}</small></span><em>{(track.audio.size / 1024 / 1024).toFixed(1)} MB</em></label>)}</div><p className="field-help">ZIP64 分块直接写盘，原音频不转码，不设总大小上限。关闭窗口后台继续；暂停或退出软件后可继续；仍需足够磁盘空间。未完成前请保留源歌曲和导出半成品，API Key 不会导出。</p><div className="export-actions"><button className="button primary" disabled={busy || !chosen.length || task?.status === 'completed'} onClick={() => void exportMusic()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{task ? '继续导出' : '导出 ZIP 音乐包'}</button>{busy && !writing && <button className="text-button" onClick={() => controllerRef.current?.abort()}>暂停并保存进度</button>}{task?.status === 'completed' && <button className="button outline" onClick={() => void presentExport(task).catch((error) => setStatus(error.message))}>保存位置 / 分享</button>}{!busy && <button className="text-button" onClick={onTasks}>传输任务</button>}</div><p className="export-status" role="status">{status}</p></section></div>;
}
