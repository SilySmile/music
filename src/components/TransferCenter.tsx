import { useEffect, useRef, useState } from 'react';
import { Download, FolderInput, LoaderCircle, Pause, Play, Trash2, X } from 'lucide-react';
import type { ImportTask, SourceTransferTask, TransferTask } from '../lib/transferTypes';
import { deleteTransfer, getTransfers } from '../lib/storage';
import { runExportTask } from '../lib/transfers';
import { presentExport } from '../lib/transferWriter';
import { dismissBackgroundTask, isAndroidBackground, openBackgroundPowerSettings, pauseBackgroundTask, pauseBackgroundTasks, resumeBackgroundTasks, useBackgroundTasks, type TaskView } from '../lib/backgroundTasks';

export default function TransferCenter({ onClose, onResumeImport, onResumeSource, onOpen, onBusy, foreground = true }: { onClose(): void; onResumeImport(task: ImportTask, files: File[]): void; onResumeSource(task: SourceTransferTask): void; onOpen(view: TaskView): void; onBusy(value: boolean): void; foreground?: boolean }) {
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  const [active, setActive] = useState('');
  const [status, setStatus] = useState('');
  const activities = useBackgroundTasks();
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = useRef<ImportTask | null>(null);
  const load = async () => setTasks(await getTransfers());
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!foreground) return;
    void load().catch(() => setStatus('任务读取失败，请检查存储空间。'));
    const timer = setInterval(() => void load().catch(() => {}), 1500);
    return () => { clearInterval(timer); };
  }, [foreground]);
  async function resume(task: TransferTask) {
    if (active || activities.some((activity) => activity.id === task.id && activity.status === 'running')) return;
    resumeBackgroundTasks();
    if (task.kind === 'import') { selected.current = task; input.current?.click(); return; }
    if (task.kind === 'source') { onResumeSource(task); return; }
    setActive(task.id); onBusy(true); controller.current = new AbortController();
    try {
      const result = await runExportTask(task, controller.current.signal, setStatus);
      setStatus(result.status === 'completed' ? `导出完成：${result.location}` : result.error || '已暂停，分块进度已保留。');
    } catch (error) { setStatus(error instanceof Error ? error.message : '任务恢复失败。'); }
    finally { setActive(''); onBusy(false); await load(); }
  }
  const labels = { running: '进行中', paused: '已暂停', failed: '可重试', completed: '已完成', review: '待核对保存' };
  return <div className="modal-backdrop"><section className="modal transfer-center" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
    <div className="modal-heading"><div><span className="eyebrow">WORK IN THE BACKGROUND</span><h2 id="transfer-title">任务中心</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭传输任务"><X size={20} /></button></div>
    <p className="field-help">关闭窗口继续运行；PC 可隐藏到托盘，安卓自选文件曲库的下载 / 补充由原生队列和常驻通知执行；其他任务仍可能受 WebView 与系统后台策略影响。系统强制停止后需手动继续，付费 AI 不自动重发；AI 时间草稿仍须核对后保存。导入恢复需重新选择同一源包，下载当前未完成歌曲重新校验。</p>
    {activities.some((task) => task.status === 'running') && <button className="button outline" onClick={() => pauseBackgroundTasks()}><Pause size={14} />暂停全部任务</button>}
    <button className="button outline" onClick={() => { resumeBackgroundTasks(); setStatus('允许继续已开启的自动任务；中断的传输请逐项继续，付费 AI 仍需手动确认。'); }}>允许继续后台任务</button>
    {isAndroidBackground() && <button className="button outline" onClick={() => void openBackgroundPowerSettings().catch((error) => setStatus(error.message))}>安卓后台运行 / 电池设置</button>}
    <input ref={input} type="file" multiple className="hidden-input" accept=".zip,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.lrc,.txt,.jpg,.png,.webp" aria-label="选择待恢复的原音乐包" onChange={(event) => { const files = Array.from(event.target.files ?? []); if (selected.current && files.length) onResumeImport(selected.current, files); event.target.value = ''; }} />
    <div className="transfer-list">
      {foreground && activities.filter((activity) => !activity.persistent).map((activity) => <article className="transfer-task" key={activity.id}>
        <div className="transfer-task-title"><LoaderCircle size={18} className={activity.status === 'running' ? 'spin' : ''} /><strong>{activity.title}</strong><span>{labels[activity.status]}</span></div>
        <p>{activity.message}</p><div className="transfer-task-actions"><button className="button outline" onClick={() => onOpen(activity.view)}>{activity.status === 'review' ? '查看草稿' : '查看任务'}</button>{activity.status === 'running' ? <button className="button outline" onClick={() => pauseBackgroundTask(activity.id)}>暂停任务</button> : <button className="icon-button" aria-label={`移除任务记录 ${activity.title}`} onClick={() => dismissBackgroundTask(activity.id)}><Trash2 size={14} /></button>}</div>
      </article>)}
      {foreground && tasks.map((task) => {
        const activity = activities.find((activity) => activity.id === task.id);
        const running = activity?.status === 'running';
        const state = running ? 'running' : task.status === 'running' ? 'paused' : task.status;
        const progress = task.kind === 'export' ? `${(task.checkpoint.offset / 1024 / 1024).toFixed(1)} MB 已写入 · ${task.checkpoint.entryIndex} / ${task.entries.length} 个文件` : `${task.completed.length} / ${task.kind === 'source' ? task.ids.length : task.total || '待扫描'} 首歌曲`;
        return <article className="transfer-task" key={task.id}><div className="transfer-task-title">{task.kind === 'import' ? <FolderInput size={19} /> : <Download size={19} />}<strong>{task.label}</strong><span>{labels[state]}</span></div><p>{progress}</p>{running && <p>{activity.message}</p>}{task.error && <small>{task.error}</small>}<div className="transfer-task-actions">
          {running ? <button className="button outline" onClick={() => pauseBackgroundTask(task.id)}><Pause size={13} />暂停并保存进度</button> : task.status !== 'completed' && <button className="button outline" disabled={!!active} onClick={() => void resume(task)}><Play size={13} />{task.kind === 'import' ? '选择源包并继续' : task.kind === 'export' ? '继续导出' : '继续传输'}</button>}
          {task.status === 'completed' && task.kind === 'export' && <button className="button outline" onClick={() => void presentExport(task).catch((error) => setStatus(error.message))}><Download size={13} />保存位置 / 分享</button>}
          {!running && <button className="icon-button" aria-label={`移除任务记录 ${task.label}`} title={task.status === 'completed' ? '移除任务记录' : '删除该任务及其检查点（已下载歌曲不会删除）'} onClick={() => void deleteTransfer(task.id).then(() => { dismissBackgroundTask(task.id); return load(); }).catch((error) => setStatus(error instanceof Error ? error.message : '删除任务失败。'))}><Trash2 size={14} /></button>}
        </div></article>;
      })}
      {!tasks.length && !activities.length && <div className="empty-state"><FolderInput size={30} /><p>任务启动后，进度会显示在这里。</p></div>}
    </div><div className="export-status" role="status">{active && <LoaderCircle size={14} className="spin" />}{status}</div>
  </section></div>;
}
