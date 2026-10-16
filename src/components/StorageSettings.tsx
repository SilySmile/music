import { useEffect, useState } from 'react';
import { FolderOpen, FolderSync, HardDrive, LoaderCircle } from 'lucide-react';
import type { LibraryInfo, LibraryProgress } from '../types';
import { isAndroidLibrary } from '../lib/androidLibrary';
import AndroidStorageSettings from './AndroidStorageSettings';

export default function StorageSettings({ onError, onExport, onChanged, blocked = false, trackCount = 0 }: { onError(message: string): void; onExport(): void; onChanged(): Promise<void>; blocked?: boolean; trackCount?: number }) {
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [selected, setSelected] = useState('');
  const [existing, setExisting] = useState<{ path: string; trackCount: number } | null>(null);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const bridge = window.tingyuDesktop;
  useEffect(() => {
    if (!bridge) return;
    void bridge.getLibraryInfo().then(setInfo).catch((error) => onError(error instanceof Error ? error.message : '音乐库路径读取失败。'));
    return bridge.onLibraryProgress(setProgress);
  }, [bridge, onError]);

  async function choose() {
    setWorking(true); setStatus('');
    try { const result = await bridge!.chooseLibraryFolder(); if (result) { setSelected(result); setExisting(null); } }
    catch (error) { onError(error instanceof Error ? error.message : '无法选择文件夹。'); }
    finally { setWorking(false); }
  }
  async function move() {
    setWorking(true); setProgress(null); setStatus('正在复制并校验，请勿关闭软件、修改源文件或移除磁盘。');
    try { setInfo(await bridge!.moveLibrary()); setSelected(''); await onChanged(); setInfo(await bridge!.getLibraryInfo()); setStatus('已切换。新导入歌曲、下载歌词与 AI 译文会保存到新目录；旧目录暂作备份保留。'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '切换失败，原目录和数据保留。'); }
    finally { setWorking(false); }
  }
  async function chooseExisting() {
    setWorking(true); setStatus(''); setExisting(null);
    try { const result = await bridge!.chooseExistingLibrary(); if (result) { setExisting(result); setSelected(''); } }
    catch (error) { setStatus(error instanceof Error ? error.message : '无法读取已有音乐库，当前目录不变。'); }
    finally { setWorking(false); }
  }
  async function useExisting() {
    setWorking(true); setProgress(null); setStatus('正在逐文件校验已有库，请勿修改文件或移除磁盘。校验成功后会刷新播放器。');
    window.dispatchEvent(new CustomEvent('tingyu-library-switching', { detail: true }));
    try { await bridge!.useExistingLibrary(); setStatus('校验通过，正在刷新并载入已有音乐库…'); }
    catch (error) {
      setStatus(error instanceof Error ? error.message : '切换失败，当前音乐库与目标文件均保留。');
      window.dispatchEvent(new CustomEvent('tingyu-library-switching', { detail: false })); setWorking(false);
    }
  }
  if (!bridge && isAndroidLibrary()) return <AndroidStorageSettings blocked={blocked} trackCount={trackCount} onError={onError} />;
  return <section className="storage-settings"><h3><HardDrive size={16} />音乐库保存路径</h3>{bridge ? <>
    <label>当前音乐库<input aria-label="当前音乐库路径" value={info?.path || '正在读取…'} readOnly /></label>
    <label>全部应用数据<input aria-label="全部应用数据路径" value={info?.internalPath || '正在读取…'} readOnly /></label>
    <p className="field-help">Windows 默认将歌曲、歌词、译文、设置、系统加密 Key、数据库和缓存统一保存在安装目录的 Data 文件夹。安装时可选择位置；升级和卸载保留 Data，请勿手动删除。系统安装临时文件及快捷方式由 Windows 管理。</p>
    {info?.error && <p className="storage-error" role="alert">{info.error}。原数据未删除，可恢复磁盘或通过下方按钮打开另一份已有音乐库。</p>}
    <div className="storage-buttons"><button className="button outline" disabled={working || !info} onClick={() => void bridge.openLibraryFolder().catch((error) => onError(error.message))}><FolderOpen size={14} />打开音乐库文件夹</button><button className="button outline" disabled={working || !!info?.error} onClick={() => void choose()}><FolderSync size={14} />选择新保存位置</button></div>
    {selected && <div className="storage-move-confirm"><label>新音乐库目录<input aria-label="新音乐库路径" value={selected} readOnly /></label><p>复制全部歌曲、封面、歌词、中文译文和翻译缓存，逐文件校验后切换；不会覆盖目标已有文件，旧目录暂不删除。请保证空间充足。</p><button className="button primary" disabled={working} onClick={() => void move()}>{working ? <LoaderCircle size={14} className="spin" /> : <FolderSync size={14} />}复制并切换音乐库</button></div>}
    <div className="storage-buttons"><button className="button outline" disabled={working} onClick={() => void chooseExisting()}><FolderOpen size={14} />打开已有音乐库</button></div>
    <p className="field-help">已有完整音乐库请选择此项，可直接选包含 library.json 的目录，或它的 Data 父目录。不复制、不合并、不覆盖；保留当前播放器设置与加密密钥。普通 MP3 / 歌词文件夹请使用「导入音乐」。</p>
    {existing && <div className="storage-move-confirm"><label>已有音乐库目录<input aria-label="已有音乐库路径" value={existing.path} readOnly /></label><p>检测到 {existing.trackCount} 首歌曲，当前库 {info?.trackCount ?? '未知'} 首。确认后校验全部音频和封面，再只切换读取位置；原库完整保留。播放会暂停并刷新页面，请先完成传输并退出使用同一库的其他播放器。</p><button className="button primary" disabled={working} onClick={() => void useExisting()}>{working ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}校验并切换到已有音乐库</button><button className="text-button" disabled={working} onClick={() => setExisting(null)}>取消切换</button></div>}
    {progress && working && <progress aria-label="音乐库迁移进度" max={progress.total || 1} value={progress.completed} />}
    {status && <p className="field-help" role="status">{status}{working && progress ? ` ${progress.completed} / ${progress.total} 个文件` : ''}</p>}
    <p className="field-help">「歌曲」子文件夹中保存原音频、封面、同名 .lrc / .txt 与 .zh.lrc / .zh.txt 中文文件，AI 译文、联网歌词和人工修改会自动写入。library.json 保留完整资料与时间轴；translations-cache.json 保留翻译缓存，不含 API Key。原 ZIP 不会被修改。</p>
    {info?.previousPath && <p className="field-help">上次音乐库目录（完整保留）：<code>{info.previousPath}</code>。两个目录不会自动同步，可用「打开已有音乐库」切换回来；确认不再需要后再自行清理。</p>}
    <details><summary>设置与内部索引存放位置</summary><p className="field-help"><code>{info?.internalPath}</code><br />这里保存偏好设置、API Key 的系统加密副本及传输任务索引。上方「选择新保存位置」仅单独移动音乐库，不移动这些设置。旧版内部歌曲会在完整校验后迁移到文件音乐库；未完成时旧记录保留。系统加密 Key 不能保证跨电脑解密，换设备后请重新填写。</p></details>
  </> : <><p className="field-help">安卓 / 浏览器目前保存在应用私有的 WebView / 浏览器数据库中，不能直接选择其内部路径。歌词和 AI 译文会一同持久保存；请导出音乐包，再通过系统文件应用保存到你指定的位置。清理应用数据或卸载前务必导出备份。</p><button className="button outline" onClick={onExport}><FolderOpen size={14} />导出到自选位置</button></>}</section>;
}
