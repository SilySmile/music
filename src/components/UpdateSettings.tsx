import { useEffect, useState } from 'react';
import { ArrowDownToLine, RefreshCw, ShieldCheck } from 'lucide-react';
import { checkUpdate, currentUpdateState, downloadUpdate, initialUpdateState, installUpdate, onUpdateState, pauseUpdate, saveUpdateConfig, updateConfig, updatesSupported, type UpdateConfig } from '../lib/appUpdates';

export default function UpdateSettings({ blocked = false }: { blocked?: boolean }) {
  const [config, setConfig] = useState<UpdateConfig | null>(null);
  const [address, setAddress] = useState('');
  const [automatic, setAutomatic] = useState(false);
  const [state, setState] = useState(initialUpdateState);
  const [working, setWorking] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [status, setStatus] = useState('');
  const supported = updatesSupported();
  const busy = working || state.phase === 'checking' || state.phase === 'downloading';
  const dirty = !!config && (address !== config.baseUrl || automatic !== config.autoCheck);
  useEffect(() => {
    let active = true; let remove: (() => void) | undefined;
    void updateConfig().then((value) => { if (active) { setConfig(value); setAddress(value.baseUrl); setAutomatic(value.autoCheck); } }).catch((error) => setStatus(error.message));
    if (supported) {
      void currentUpdateState().then((value) => { if (active) setState(value); });
      void onUpdateState((value) => { if (active) setState(value); }).then((stop) => { if (active) remove = stop; else stop(); });
    }
    return () => { active = false; remove?.(); };
  }, [supported]);
  async function save() {
    setWorking(true); setStatus(''); setConfirmInstall(false);
    try { const value = await saveUpdateConfig({ baseUrl: address, autoCheck: automatic }); setConfig(value); setAddress(value.baseUrl); setAutomatic(value.autoCheck); setState(initialUpdateState()); setStatus('地址已保存，后续可直接换成自己的 HTTPS 域名。'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); }
    finally { setWorking(false); }
  }
  async function install() {
    setWorking(true); setStatus('');
    try {
      const result = await installUpdate();
      setStatus(result.permissionNeeded ? '请在系统页面允许本应用安装更新，然后返回再次点击安装。' : result.portable ? '已打开便携包所在位置。请退出播放器后替换旧启动器，务必保留 Data 文件夹。' : result.testVerified ? '测试模式已校验安装包，未执行安装。' : '已交给系统安装器；歌曲和配置保留，请勿卸载应用或清理数据。');
      setConfirmInstall(false);
    } catch (error) { setStatus(error instanceof Error ? error.message : '安装启动失败'); }
    finally { setWorking(false); }
  }
  return <section className="update-settings"><h3><RefreshCw size={16} />软件更新</h3><p className="field-help">当前版本 v{config?.currentVersion || state.currentVersion} · {config?.platform === 'android' ? '安卓' : 'Windows'}。更新不会上传音乐库、歌词或 AI 密钥。</p>
    <label>更新服务器域名 / 地址<input aria-label="更新服务器地址" value={address} spellCheck={false} autoComplete="off" placeholder="https://你的域名/music-updates/" disabled={!supported || busy} onChange={(event) => { setAddress(event.target.value); setStatus(''); }} /></label>
    <p className="field-help">可填域名或完整 HTTPS 更新目录；只填域名时自动使用 /music-updates/。未来更换域名只需修改此处，仍须提供同一发布者签名的清单与安装包。</p>
    <label className="remember-key"><input type="checkbox" checked={automatic} disabled={!supported || busy} onChange={(event) => setAutomatic(event.target.checked)} />启动后检查更新（每天最多一次，只检查，不自动下载）</label>
    <div className="storage-buttons"><button className="button outline" disabled={!supported || busy || !config} onClick={() => void save()}>保存更新地址</button><button className="button outline" disabled={!supported || busy || !config || dirty} onClick={() => { setStatus(''); setConfirmInstall(false); void checkUpdate().then(setState).catch((error) => setStatus(error.message)); }}><RefreshCw size={14} />检查更新</button></div>
    {dirty && <p className="field-help">地址或检查选项已修改，请先保存。</p>}
    {state.release && <article className="update-release"><strong>新版本 v{state.release.version} · {(state.release.size / 1024 / 1024).toFixed(1)} MB</strong><pre>{state.release.notes}</pre></article>}
    {state.total > 0 && <div className="update-progress"><progress aria-label="更新下载进度" max={state.total} value={state.bytes} /><small>{(state.bytes / 1024 / 1024).toFixed(1)} / {(state.total / 1024 / 1024).toFixed(1)} MB</small></div>}
    <div className="storage-buttons">{state.release && state.phase !== 'downloaded' && state.phase !== 'downloading' && <button className="button primary" disabled={busy || dirty} onClick={() => { setStatus(''); void downloadUpdate().then(setState).catch((error) => setStatus(error.message)); }}><ArrowDownToLine size={14} />{state.bytes ? '继续下载更新' : '下载更新'}</button>}{state.phase === 'downloading' && <button className="button outline" onClick={() => void pauseUpdate().then(setState)}>暂停下载</button>}{state.phase === 'downloaded' && <button className="button primary" disabled={busy || dirty || blocked} onClick={() => setConfirmInstall(true)}>{config?.platform === 'android' ? '安装安卓更新' : state.release?.kind === 'portable' ? '查看新版便携包' : '退出并安装更新'}</button>}</div>
    {blocked && state.phase === 'downloaded' && <p className="field-help">请先完成当前导入 / 迁移任务，再退出安装。</p>}
    {confirmInstall && <div className="update-confirm"><p>{config?.platform === 'android' ? '将打开系统覆盖安装器。请勿先卸载，取消安装不影响现有数据。' : state.release?.kind === 'portable' ? '便携版需手动替换启动器，旧 Data 不可删除。' : '将退出播放器并运行覆盖安装，安装到当前程序目录，保留 Data 中的歌曲、歌词和配置。确认前请完成所有传输任务。'}</p><button className="button primary" disabled={working || blocked} onClick={() => void install()}>确认安装更新</button><button className="text-button" disabled={working} onClick={() => setConfirmInstall(false)}>暂不安装</button></div>}
    <p className="field-help update-status" role="status">{status || state.message || (!supported ? '浏览器预览不安装更新，请在 PC 或安卓客户端使用。' : '点击检查更新，下载可暂停并继续。')}</p>
    <p className="field-help"><ShieldCheck size={12} /> 强制验证 HTTPS、发布签名与 SHA-256，校验失败不会安装；不提供跳过验证选项。{config?.configPath && <><br />地址配置：<code>{config.configPath}</code><br />安装包缓存：<code>{config.downloadDirectory}</code></>}</p>
  </section>;
}
