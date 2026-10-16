import { useEffect, useState } from 'react';
import { Copy, FolderOpen, FolderSync, HardDrive, LoaderCircle } from 'lucide-react';
import { androidLibrary, copyAndroidLibrary, type AndroidLibraryInfo, type LibrarySelection } from '../lib/androidLibrary';
import { getAndroidTranslationEntries, getTracks } from '../lib/storage';
import { androidPlayer } from '../lib/androidPlayback';
import type { LibraryProgress } from '../types';

export default function AndroidStorageSettings({ blocked, trackCount, onError }: { blocked: boolean; trackCount: number; onError(message: string): void }) {
  const [info, setInfo] = useState<AndroidLibraryInfo | null>(null);
  const [candidate, setCandidate] = useState<(LibrarySelection & { mode: 'copy' | 'existing' }) | null>(null);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    let remove: (() => void) | undefined;
    void androidLibrary.info().then((value) => { if (active) setInfo(value); }).catch((error) => onError(error.message));
    void androidLibrary.addListener('progress', (value) => { if (active) setProgress(value); }).then((listener) => { if (active) remove = () => void listener.remove(); else void listener.remove(); });
    return () => { active = false; remove?.(); };
  }, [onError]);
  const disabled = blocked || working;

  async function choose(mode: 'copy' | 'existing') {
    setWorking(true); setStatus(''); setCandidate(null);
    try { const selected = await androidLibrary.choose({ mode }); if (!('cancelled' in selected)) setCandidate({ ...selected, mode }); }
    catch (error) { setStatus(error instanceof Error ? error.message : '文件夹选择失败，当前曲库未改变。'); }
    finally { setWorking(false); }
  }
  async function activate() {
    if (!candidate) return;
    setWorking(true); setProgress(null); setStatus('正在处理，请保持前台，不要修改文件或拔出存储卡。');
    window.dispatchEvent(new CustomEvent('tingyu-library-switching', { detail: true }));
    try {
      await androidPlayer.control({ action: 'stop' });
      if (candidate.mode === 'copy') await copyAndroidLibrary(candidate, await getTracks(), await getAndroidTranslationEntries(), setProgress);
      else await androidLibrary.activate({ target: candidate.token });
      window.location.reload();
    } catch (error) {
      setStatus(`${error instanceof Error ? error.message : '操作失败'}。当前曲库保留；复制失败的目标可能含部分已完成歌曲，请勿当作完整备份。`);
      window.dispatchEvent(new CustomEvent('tingyu-library-switching', { detail: false })); setWorking(false); setCandidate(null);
    }
  }
  async function useDatabase() {
    setWorking(true); setStatus('');
    window.dispatchEvent(new CustomEvent('tingyu-library-switching', { detail: true }));
    try { await androidPlayer.control({ action: 'stop' }); await androidLibrary.useDatabase(); window.location.reload(); }
    catch (error) { setStatus(error instanceof Error ? error.message : '无法切回内部曲库'); window.dispatchEvent(new CustomEvent('tingyu-library-switching', { detail: false })); setWorking(false); }
  }
  return <section className="storage-settings"><h3><HardDrive size={16} />音乐库保存路径</h3>
    <label>当前音乐库地址<input aria-label="当前音乐库路径" value={info?.path || '正在读取…'} readOnly /></label>
    <p className="field-help">{info?.storageMode === 'folder' ? '自选文件音乐库：歌曲、封面、原文歌词、中文译文与缓存都写入此文件夹，重启直接打开，不用重复导入。' : '当前仍是应用内部数据库；系统管理实际数据库子目录，普通文件管理器无法直接打开。选择下方“复制到自选目录”，只需搬出一次即可成为可重复打开的文件音乐库。'} 当前 {trackCount} 首。</p>
    {info?.uri && <label>系统授权地址<input aria-label="音乐库授权地址" value={info.uri} readOnly /></label>}
    {info?.error && <p className="storage-error" role="alert">{info.error} 不会创建替代空库，请重新授权原目录或选择另一份已有库。</p>}
    <div className="storage-buttons"><button className="button outline" disabled={!info || disabled} onClick={() => void navigator.clipboard.writeText(info!.uri ? `${info!.path}\n${info!.uri}` : info!.path).then(() => setStatus('音乐库地址已复制。')).catch(() => setStatus('无法自动复制，请长按上方地址复制。'))}><Copy size={14} />复制地址</button><button className="button outline" disabled={disabled} onClick={() => void choose('existing')}><FolderOpen size={14} />打开已有音乐库</button><button className="button outline" disabled={!info || !!info.error || disabled} onClick={() => void choose('copy')}><FolderSync size={14} />复制到自选目录</button></div>
    {candidate && <div className="storage-move-confirm"><label>{candidate.mode === 'copy' ? '新音乐库目录' : '已有音乐库目录'}<input aria-label="待切换音乐库路径" value={candidate.path} readOnly /></label><p>{candidate.mode === 'copy' ? `复制当前 ${trackCount} 首歌曲、封面、双语歌词与缓存，逐文件校验后切换。原库保留，不覆盖目标已有文件，需要足够剩余空间。` : `检测到 ${candidate.trackCount} 首歌曲。只核验并切换读取，不复制、不合并，保留当前设置、加密密钥及原曲库。`}</p><button className="button primary" disabled={disabled} onClick={() => void activate()}>{working ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}{candidate.mode === 'copy' ? '复制、校验并切换' : '核验并打开此音乐库'}</button><button className="text-button" disabled={disabled} onClick={() => setCandidate(null)}>取消</button></div>}
    {working && progress && <><p className="field-help">{progress.stage} · {progress.completed} / {progress.total}</p><progress aria-label="音乐库迁移进度" max={progress.total || 1} value={progress.completed} /></>}
    {status && <p className="field-help" role="status">{status}</p>}
    <p className="field-help">通过系统文件选择器授权，可选手机本地或存储卡中的子文件夹。建议在 Music 或 Documents 下建专用目录；部分系统不允许选择存储根目录、Download 根目录、Android/data 或 Android/obb。云盘提供器可能不支持安全写入，请使用本地目录。</p>
    <p className="field-help">“已有音乐库”需包含 library.json 与“歌曲”子目录，兼容 PC 文件音乐库。可将整个库复制到手机后直接选中；普通音频文件夹或 ZIP 仍需首次导入。卸载后文件库保留，但重装需要重新授权目录。请勿同时用多个播放器写入同一库。</p>
    {info?.previousPath && <p className="field-help">上次音乐库（保留，不自动同步）：<code>{info.previousPath}</code></p>}
    <details><summary>内部设置、旧库与后台播放副本</summary><p className="field-help">应用私有数据：<code>{info?.internalPath || '正在读取…'}</code>。加密密钥、设置与传输任务仍由应用管理，不会写入公共曲库。内部旧库在复制成功后仍保留，可切回；不是自动同步备份。卸载或清除应用数据会删除内部库与设置，但不会删除自选公共目录。后台播放目前仍在 files/playback-audio 保留校验后的音频副本，需要额外空间。</p>{info?.storageMode === 'folder' && <button className="button outline" disabled={disabled} onClick={() => void useDatabase()}>切回保留的内部曲库</button>}</details>
  </section>;
}
