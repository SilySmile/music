import { useEffect, useRef, useState } from 'react';
import { Download, FolderInput, LoaderCircle, Pause, Play, Trash2, X } from 'lucide-react';
import type { ImportTask, TransferTask } from '../lib/transferTypes';
import { deleteTransfer, getTransfers } from '../lib/storage';
import { runExportTask } from '../lib/transfers';
import { presentExport } from '../lib/transferWriter';

export default function TransferCenter({ onClose, onResumeImport }: { onClose(): void; onResumeImport(task: ImportTask, files: File[]): void }) {
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  const [active, setActive] = useState('');
  const [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = useRef<ImportTask | null>(null);
  const load = async () => setTasks(await getTransfers());
  useEffect(() => { void load().catch(() => setStatus('任务读取失败，请检查存储空间。')); return () => controller.current?.abort(); }, []);
  async function resume(task: TransferTask) {
    if (active) return;
    if (task.kind === 'import') { selected.current = task; input.current?.click(); return; }
    setActive(task.id); controller.current = new AbortController();
    try {
      const result = await runExportTask(task, controller.current.signal, setStatus);
      setStatus(result.status === 'completed' ? `导出完成：${result.location}` : result.error || '已暂停，分块进度已保留。');
    } catch (error) { setStatus(error instanceof Error ? error.message : '任务恢复失败。'); }
    finally { setActive(''); await load(); }
  }
  return <div className="modal-backdrop"><section className="modal transfer-center" role="dialog" aria-modal="true" aria-labelledby="transfer-title"><div className="modal-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2 id="transfer-title">传输任务</h2></div><button className="icon-button" disabled={!!active} onClick={onClose} aria-label="关闭传输任务"><X size={20} /></button></div><p className="field-help">关闭软件后进度仍保留。导入需要重新选择同一个源包，已完成歌曲跳过，未完成歌曲重新读取；导出从已写入的文件分块继续。设备空间仍需充足。</p><input ref={input} type="file" multiple className="hidden-input" accept=".zip,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.lrc,.txt,.jpg,.png,.webp" aria-label="选择待恢复的原音乐包" onChange={(event) => { const files = Array.from(event.target.files ?? []); if (selected.current && files.length) onResumeImport(selected.current, files); }} />
    <div className="transfer-list">{tasks.map((task) => <article className="transfer-task" key={task.id}><div className="transfer-task-title">{task.kind === 'import' ? <FolderInput size={19} /> : <Download size={19} />}<strong>{task.label}</strong><span>{active === task.id ? '进行中' : task.status === 'completed' ? '已完成' : task.status === 'failed' ? '可重试' : '待继续'}</span></div><p>{task.kind === 'import' ? `${task.completed.length} / ${task.total || '待扫描'} 首歌曲` : `${(task.checkpoint.offset / 1024 / 1024).toFixed(1)} MB 已写入 · ${task.checkpoint.entryIndex} / ${task.entries.length} 个文件`}</p>{task.error && <small>{task.error}</small>}<div className="transfer-task-actions">{task.status !== 'completed' && <button className="button outline" disabled={!!active} onClick={() => void resume(task)}><Play size={13} />{task.kind === 'import' ? '选择源包并继续' : '继续导出'}</button>}{task.status === 'completed' && task.kind === 'export' && <button className="button outline" disabled={!!active} onClick={() => void presentExport(task).catch((error) => setStatus(error.message))}><Download size={13} />保存位置 / 分享</button>}{task.status === 'completed' && <button className="icon-button" aria-label={`移除任务记录 ${task.label}`} disabled={!!active} onClick={() => void deleteTransfer(task.id).then(load)}><Trash2 size={14} /></button>}</div></article>)}{!tasks.length && <div className="empty-state"><FolderInput size={30} /><p>导入或导出后，进度会保存在这里。</p></div>}</div>
    {active && <button className="button outline" onClick={() => controller.current?.abort()}><Pause size={14} />暂停并保存进度</button>}<div className="export-status" role="status">{active && <LoaderCircle size={14} className="spin" />}{status}</div></section></div>;
}
