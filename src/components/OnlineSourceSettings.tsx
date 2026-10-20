import { useEffect, useRef, useState } from 'react';
import { Check, Cloud, Download, LoaderCircle, RefreshCw, Upload } from 'lucide-react';
import type { Track } from '../types';
import { listSource, loadSourceConfig, normalizeSourceUrl, parseSourceConnection, saveSourceConfig, sourceRequest, type SourceConfig, type SourceInfo, type SourceTrack } from '../lib/onlineSource';
import type { SourceAutoController } from '../lib/useSourceAutoSync';
import { createSourceTransfer, needsSourceSupplement, runSourceTransfer, sourceTransferLimit, sourceTransfersRunning } from '../lib/sourceTransfers';
import type { SourceTransferTask } from '../lib/transferTypes';
import { beginBackgroundTask, type BackgroundHandle } from '../lib/backgroundTasks';

export default function OnlineSourceSettings({ tracks, blocked, auto, onChanged, resumeTask, onResumed, onSaved, foreground = true }: { tracks: Track[]; blocked: boolean; auto: SourceAutoController; onChanged(): Promise<void>; resumeTask?: SourceTransferTask | null; onResumed?(): void; onSaved?(track: Track): void; foreground?: boolean }) {
  const [config, setConfig] = useState<SourceConfig>({ baseUrl: '', token: '', remember: true });
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const [remote, setRemote] = useState<SourceTrack[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<'remote' | 'local'>('remote');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [working, setWorking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmation, setConfirmation] = useState<'upload' | 'download' | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void loadSourceConfig().then((value) => { if (mounted.current) setConfig(value); }).catch((error) => { if (mounted.current) setStatus(error.message); });
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const update = (patch: Partial<SourceConfig>) => { setConfig((previous) => ({ ...previous, ...patch })); setDirty(true); setInfo(null); setRemote([]); setSelected([]); setConfirmation(null); };
  const progress = (message: string) => { if (mounted.current) setStatus(message); };
  const disabled = blocked || working || auto.state.running;
  const records = tab === 'local' ? tracks : remote.map((record) => record.metadata);
  const visible = records.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query.toLowerCase()));
  const currentSelection = selected.filter((id) => records.some((track) => track.id === id));
  const existingRemote = currentSelection.filter((id) => remote.some((record) => record.metadata.id === id)).length;
  useEffect(() => { if (resumeTask && !lock.current) { onResumed?.(); void transfer(resumeTask); } }, [resumeTask]);

  useEffect(() => {
    if (!auto.state.finishedAt || dirty || !info || auto.state.running) return;
    let current = true;
    void listSource().then((records) => { if (current) setRemote(records); }).catch(() => {});
    return () => { current = false; };
  }, [auto.state.finishedAt, auto.state.running, dirty, info]);
  async function connect(automatic = false) {
    if (lock.current) return; lock.current = true;
    setWorking(true); setStatus('正在保存配置并连接…'); setConfirmation(null);
    controller.current = new AbortController();
    let job: BackgroundHandle | undefined;
    let connected = false;
    try {
      job = await beginBackgroundTask({ id: 'source-connect', title: '连接与读取云端曲库', view: 'settings', controller: controller.current });
      await auto.pause();
      let saved = await saveSourceConfig({ ...config, baseUrl: normalizeSourceUrl(config.baseUrl), autoSync: false, connected: false });
      const result = await sourceRequest<SourceInfo>({ method: 'GET', path: '/info' }, controller.current.signal);
      if (result.product !== 'xianqiji-online-library' || result.schema !== 1 || result.chunkBytes !== 1024 * 1024) throw new Error('此地址不是兼容的弦栖霁在线曲库。');
      if (automatic && (!result.canWrite || !result.verification)) throw new Error(result.canWrite ? '请先更新服务器，开启在线文件核验支持。' : '自动上传需要读写密钥，此密钥只有读取权限。');
      const list = await listSource(sourceRequest, controller.current.signal);
      controller.current.signal.throwIfAborted();
      saved = await saveSourceConfig({ ...saved, connected: true, autoSync: automatic });
      window.dispatchEvent(new CustomEvent('xianqiji-cloud-catalog', { detail: { config: saved, info: result, records: list } }));
      connected = true;
      if (mounted.current) { setConfig(saved); setInfo(result); setRemote(list); setSelected([]); setDirty(false); setStatus(`连接成功 · ${list.length} 首 · ${result.canWrite ? '可读取和上传' : '只读访问'}`); }
    } catch (error) { progress(error instanceof Error ? error.message : '连接失败，请核对地址、密钥与服务器状态。'); }
    finally { await job?.finish(controller.current.signal.aborted ? 'paused' : connected ? 'completed' : 'failed', connected ? '连接成功，云端歌曲已加入全部歌曲。' : '连接未完成，请核对地址、权限和网络。'); lock.current = false; if (mounted.current) setWorking(false); }
  }
  function supplementNeeded(id: string) {
    const local = tracks.find((track) => track.id === id && !track.cloud);
    const record = remote.find((item) => item.metadata.id === id);
    return needsSourceSupplement(local, record ?? { metadata: { lyrics: [] } });
  }
  async function transfer(resume?: SourceTransferTask) {
    if (!resume && !confirmation || lock.current) return; lock.current = true;
    const action = resume?.direction || confirmation!; const chosen = [...currentSelection];
    setWorking(true); setConfirmation(null); controller.current = new AbortController();
    try {
      await auto.pause();
      const saved = await loadSourceConfig();
      if (!resume && (normalizeSourceUrl(saved.baseUrl) !== normalizeSourceUrl(config.baseUrl) || saved.token !== config.token || dirty)) throw new Error('配置已改变，请先重新连接后确认。');
      if (!resume && action === 'download' && sourceTransfersRunning('download') >= sourceTransferLimit('download')) throw new Error('已有 2 个下载 / 补充任务在运行，请等待其中一个完成，或在任务中心暂停其中一个。');
      const ids = resume ? chosen : action === 'download' ? chosen.filter(supplementNeeded) : chosen;
      if (!resume && !ids.length) { progress('所选歌曲在本地都已完整（音频、封面、中文歌词），没有需要补充的内容。'); return; }
      if (!resume && action === 'download' && ids.length < chosen.length) progress(`已跳过 ${chosen.length - ids.length} 首本地已完整的歌曲，本次补充 ${ids.length} 首。`);
      const task = resume || await createSourceTransfer(action, ids, saved);
      const signal = controller.current.signal;
      window.dispatchEvent(new CustomEvent('xianqiji-source-transferring', { detail: true }));
      // The task keeps running in the background so a second download can be started right away;
      // the upper limit inside runSourceTransfer still rejects a third one.
      void runSourceTransfer(task, signal, progress, async (track) => { onSaved?.(track); })
        .then(async (result) => { if (result.status === 'completed') { const list = await listSource(); if (mounted.current) { setRemote(list); setSelected([]); } } })
        .catch((error) => progress(error instanceof Error ? error.message : '任务未启动，请检查任务中心或稍后重试。'))
        .finally(async () => { await onChanged().catch(() => {}); const active = sourceTransfersRunning('download') + sourceTransfersRunning('upload') > 0; window.dispatchEvent(new CustomEvent('xianqiji-source-transferring', { detail: active })); });
      progress(`${action === 'upload' ? '上传' : '下载 / 补充'}任务已开始，可在「传输任务」查看进度；下载最多可同时进行 2 个。`);
    } catch (error) { progress(error instanceof Error ? error.message : '任务未启动，请检查任务中心或稍后重试。'); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  return <section className="online-source-settings"><h3><Cloud size={16} />云端音乐</h3>
    <p className="field-help">填写服务器地址即可听歌，上传密钥可以留空。连接后云端歌曲直接显示在“全部歌曲”，点播哪首就缓存哪首到当前本地音乐库，包含音频、封面和歌词；不会预先下载整库。</p>
    <label>音源链接<input aria-label="在线音源链接" value={config.baseUrl} disabled={disabled} onChange={(event) => update({ baseUrl: event.target.value, token: '', autoSync: false })} placeholder="https://你的域名/music-library/" /></label>
    <label>上传密钥（选填，听歌可留空）<input aria-label="在线曲库访问密钥" type="password" autoComplete="off" value={config.token} disabled={disabled} onChange={(event) => update({ token: event.target.value })} placeholder="留空只听歌；填写有效写入密钥才可上传" /></label>
    <button className="button primary" disabled={disabled || !config.baseUrl} onClick={() => void connect()}><Cloud size={14} />连接云端音乐</button>
    {status && <p className="field-help" role="status">{status}</p>}
    <details className="cloud-advanced"><summary>上传与高级管理（可选）</summary>
    <label className="source-remember"><input type="checkbox" checked={config.remember} disabled={disabled} onChange={(event) => update({ remember: event.target.checked })} />使用系统加密记住曲库密钥</label>
    <label>导入连接配置<input type="file" aria-label="导入曲库连接配置" accept=".json,.xqsource,application/json" disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (file.size > 16384) { progress('连接配置过大，请选择正确文件。'); return; } void file.text().then((text) => { update(parseSourceConnection(text)); progress('已填入地址和密钥；确认服务器后，点击“一键连接并自动上传”才开始同步。连接文件含访问凭证，请勿公开分享。'); }).catch((error) => progress(error.message)); }} /></label>
    {config.path && <p className="field-help">安全配置：<code>{config.path}</code>。不勾选记住时，密钥仅在本次运行有效。</p>}
    <div className="storage-buttons"><button className="button primary" disabled={disabled || !config.baseUrl || !config.token} onClick={() => void connect(true)}><Upload size={14} />一键连接并自动上传</button><button className="button outline" disabled={disabled || !config.baseUrl || !config.token} onClick={() => void connect()}>{working ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}保存并连接 / 刷新</button>{working && <button className="button outline" onClick={() => controller.current?.abort()}>暂停操作</button>}{auto.state.enabled && <button className="button outline" disabled={working} onClick={() => void auto.pause().catch((error) => progress(error.message))}>暂停自动上传</button>}{auto.state.enabled && !auto.state.running && <button className="button outline" disabled={working || blocked} onClick={auto.check}>立即核对</button>}</div>
    {auto.state.message && <div className="source-auto-status" role="status"><strong>{auto.state.enabled ? '自动上传已开启' : '自动上传已暂停'}</strong><p>{auto.state.message}</p>{auto.state.issues.length > 0 && <details><summary>待处理歌曲（显示前 {auto.state.issues.length} 首）</summary>{auto.state.issues.map((issue) => <p key={issue.id}><strong>{issue.title}</strong> · {issue.reason}</p>)}</details>}</div>}
    {info && !dirty && <><div className="source-tabs"><button className={`button ${tab === 'remote' ? 'primary' : 'outline'}`} disabled={disabled} onClick={() => { setTab('remote'); setSelected([]); setConfirmation(null); }}>线上曲库 · {remote.length}</button><button className={`button ${tab === 'local' ? 'primary' : 'outline'}`} disabled={disabled} onClick={() => { setTab('local'); setSelected([]); setConfirmation(null); }}>本地可上传 · {tracks.length}</button></div>
      <label>搜索歌曲<input aria-label="搜索在线曲库歌曲" value={query} disabled={working} onChange={(event) => setQuery(event.target.value)} placeholder="歌曲 / 歌手 / 专辑" /></label>
      <div className="source-list">{foreground && visible.map((track) => <label className="source-song" key={track.id}><input type="checkbox" checked={selected.includes(track.id)} disabled={disabled} onChange={(event) => { setSelected((previous) => event.target.checked ? [...previous, track.id] : previous.filter((id) => id !== track.id)); setConfirmation(null); }} /><span><strong>{track.title}</strong><small>{track.artist} · {track.lyrics.length ? `${track.lyrics.length} 行歌词` : '无歌词'} · {track.lyrics.some((line) => line.translation) ? '有中文' : '无中文'}</small></span>{tab === 'remote' && tracks.some((local) => local.id === track.id) && <Check size={14} />}</label>)}{!visible.length && <p className="field-help">暂无歌曲。可切换到本地列表，选择要上传的歌曲。</p>}</div>
      <div className="storage-buttons"><button className="button outline" disabled={disabled || !visible.length} onClick={() => { setSelected(visible.map((track) => track.id)); setConfirmation(null); }}>选择当前列表</button><button className="button primary" disabled={disabled || !currentSelection.length || tab === 'local' && !info.canWrite} onClick={() => setConfirmation(tab === 'local' ? 'upload' : 'download')}>{tab === 'local' ? <Upload size={14} /> : <Download size={14} />}{tab === 'local' ? '上传到线上' : '下载 / 补充到本地'} · {currentSelection.length}</button></div>
      {confirmation && <div className="storage-move-confirm"><strong>{confirmation === 'upload' ? `确认上传 ${currentSelection.length} 首？` : `确认下载 / 补充 ${currentSelection.length} 首？`}</strong><p>{confirmation === 'upload' ? `将把所选音频、封面、歌词和译文发送到 ${config.baseUrl}。其中 ${existingRemote} 首线上已有相同音频，核验通过后直接返回已有歌曲并计为成功，不重复传音频、不覆盖歌词。需要同步后续保存的歌词和译文时，可开启自动上传。` : '新歌曲下载并校验后加入当前本地库；已有同音频歌曲只补充缺失的封面、原文及按时间和原文对应的中文，不覆盖本地已有译文、收藏或播放记录。单首下载中断需重试该首，已保存歌曲保留。'}</p><button className="button primary" disabled={disabled} onClick={() => void transfer()}>确认{confirmation === 'upload' ? '上传' : '下载并保存'}</button><button className="text-button" disabled={disabled} onClick={() => setConfirmation(null)}>取消</button></div>}
    </>}
    <p className="field-help">自动核对不消耗 AI token；相同文件跳过，断网后重试，冲突保留两端。不会预先下载未点播的歌曲，也不会删除任一端歌曲。旧配置升级后不擅自开启；安卓自选文件曲库的下载 / 补充使用原生队列，通知栏可暂停；上传等其他任务仍可能受 WebView 与系统后台策略影响，系统终止后到任务中心继续。切换曲库或手动传输前请先暂停自动上传。公开读取开启时分享地址即可听歌；写入密钥仅由你自己保管。</p>
    </details>
  </section>;
}
