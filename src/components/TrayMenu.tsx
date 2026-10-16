import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Heart, Monitor, Pause, Play, Power, Repeat, Repeat1, Settings2, Shuffle, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { DesktopSnapshot, DesktopState, TrayAction } from '../types';

export default function TrayMenu() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [desktop, setDesktop] = useState<DesktopState | null>(null);
  const [volume, setVolume] = useState(0.7);
  const dragging = useRef(false);

  useEffect(() => {
    document.documentElement.classList.add('tray-menu-document');
    const bridge = window.tingyuDesktop;
    if (!bridge) return;
    const receive = (value: DesktopSnapshot) => { setSnapshot(value); if (!dragging.current) setVolume(value.volume); };
    void bridge.getSnapshot().then((value) => { if (value) receive(value); });
    void bridge.getState().then(setDesktop);
    const unsubscribeSnapshot = bridge.onSnapshot(receive);
    const unsubscribeState = bridge.onState(setDesktop);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') bridge.hideTrayMenu(); };
    window.addEventListener('keydown', onKeyDown);
    return () => { unsubscribeSnapshot(); unsubscribeState(); window.removeEventListener('keydown', onKeyDown); document.documentElement.classList.remove('tray-menu-document'); };
  }, []);

  const control = (action: TrayAction, value?: number) => window.tingyuDesktop?.trayControl(action, value);
  const mode = snapshot?.mode ?? 'list';
  const modeName = mode === 'list' ? '列表循环' : mode === 'shuffle' ? '随机播放' : '单曲循环';
  const setPlayerVolume = (value: number) => { setVolume(value); control('set-volume', value); };

  return <main className="tray-card" aria-label="弦栖霁托盘菜单">
    <div className="tray-playback"><button aria-label="托盘上一首" title="上一首" disabled={!snapshot?.hasTrack} onClick={() => control('previous')}><SkipBack size={20} fill="currentColor" /></button><button className="tray-play-main" aria-label={snapshot?.playing ? '托盘暂停' : '托盘播放'} title={snapshot?.playing ? '暂停' : '播放'} disabled={!snapshot?.hasTrack} onClick={() => control('play-pause')}>{snapshot?.playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}</button><button aria-label="托盘下一首" title="下一首" disabled={!snapshot?.hasTrack} onClick={() => control('next')}><SkipForward size={20} fill="currentColor" /></button></div>
    <div className="tray-track"><button className={snapshot?.favorite ? 'tray-favorite liked' : 'tray-favorite'} aria-label={snapshot?.favorite ? '托盘取消收藏' : '托盘收藏'} aria-pressed={!!snapshot?.favorite} title={snapshot?.favorite ? '取消收藏' : '收藏歌曲'} disabled={!snapshot?.hasTrack} onClick={() => control('toggle-favorite')}><Heart size={20} fill={snapshot?.favorite ? 'currentColor' : 'none'} /></button><button className="tray-track-name" onClick={() => control('show-main')} title={snapshot?.title || '打开音乐库'}><strong>{snapshot?.title || '还没有正在播放的歌曲'}</strong><small>{snapshot?.artist || '打开音乐库，选一首喜欢的歌'}</small></button><button className="tray-mode" aria-label={`托盘播放模式：${modeName}`} title={modeName} onClick={() => control('cycle-mode')}>{mode === 'shuffle' ? <Shuffle size={18} /> : mode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}</button></div>
    <div className="tray-volume"><button aria-label={volume ? '托盘静音' : '托盘取消静音'} title={volume ? '静音' : '取消静音'} onClick={() => setPlayerVolume(volume ? 0 : 0.7)}>{volume ? <Volume2 size={21} /> : <VolumeX size={21} />}</button><input aria-label="托盘音量" type="range" min="0" max="1" step="0.01" value={volume} style={{ '--tray-volume': `${volume * 100}%` } as React.CSSProperties} onPointerDown={() => { dragging.current = true; }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }} onBlur={() => { dragging.current = false; }} onChange={(event) => setPlayerVolume(Number(event.target.value))} /><span>{Math.round(volume * 100)}%</span></div>
    <div className="tray-menu-items"><button className="tray-menu-item" onClick={() => control('desktop-toggle')}><Monitor size={19} /><span>{desktop?.visible ? '关闭桌面歌词' : '开启桌面歌词'}</span><small>{desktop?.visible ? '已开启' : '已关闭'}</small></button><button className="tray-menu-item" onClick={() => control('show-main')}><ArrowUpRight size={19} /><span>打开主窗口</span></button><button className="tray-menu-item" onClick={() => control('settings')}><Settings2 size={19} /><span>偏好设置</span></button></div>
    <button className="tray-menu-item tray-quit" onClick={() => control('quit')}><Power size={18} /><span>退出弦栖霁</span><small>结束播放</small></button>
  </main>;
}
