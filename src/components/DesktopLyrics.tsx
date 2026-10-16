import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Columns2, Disc3, GripVertical, Languages, Lock, Minus, Palette, Pause, Play, Plus, Settings2, SkipBack, SkipForward, Unlock, X } from 'lucide-react';
import type { DesktopHitRegion, DesktopSnapshot, DesktopState } from '../types';
import { desktopContent, desktopLineGap } from '../lib/desktopLyrics';

const themes: DesktopState['theme'][] = ['gold', 'cyan', 'green', 'coral'];

export default function DesktopLyrics() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [style, setStyle] = useState<DesktopState>({ visible: true, locked: false, theme: 'gold', fontSize: 34, opacity: 1, layout: 'horizontal', verticalContent: 'auto', lineGap: 24 });
  const [clock, setClock] = useState({ position: 0, received: performance.now() });
  const [now, setNow] = useState(performance.now());
  const [hovered, setHovered] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const surface = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('desktop-lyrics-document');
    const bridge = window.tingyuDesktop;
    if (!bridge) return;
    const receive = (next: DesktopSnapshot) => { setSnapshot(next); setClock({ position: next.position, received: performance.now() }); };
    void bridge.getState().then(setStyle);
    void bridge.getSnapshot().then((value) => { if (value) receive(value); });
    const unsubscribeSnapshot = bridge.onSnapshot(receive);
    const unsubscribeState = bridge.onState(setStyle);
    const unsubscribePointer = bridge.onPointer(setHovered);
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => { clearInterval(timer); unsubscribeSnapshot(); unsubscribeState(); unsubscribePointer(); document.documentElement.classList.remove('desktop-lyrics-document'); };
  }, []);

  useEffect(() => { if (!hovered || style.locked) setToolsOpen(false); }, [hovered, style.locked]);

  useLayoutEffect(() => {
    const bridge = window.tingyuDesktop;
    const element = surface.current;
    if (!bridge || !element) return;
    const publish = () => bridge.setHitRegions([...element.querySelectorAll<HTMLElement>('[data-desktop-interactive]')].map((target) => {
      const bounds = target.getBoundingClientRect();
      return { kind: target.dataset.desktopInteractive as DesktopHitRegion['kind'], x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }));
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    for (const target of element.querySelectorAll('[data-desktop-interactive]')) observer.observe(target);
    const frame = requestAnimationFrame(publish);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); bridge.setHitRegions([]); };
  }, [style.locked, style.layout, toolsOpen]);

  const elapsed = snapshot?.playing ? Math.max(0, now - clock.received) / 1000 : 0;
  const position = clock.position + elapsed;
  const progress = snapshot && snapshot.lineEnd > snapshot.lineStart ? Math.max(0, Math.min(100, (position - snapshot.lineStart) / (snapshot.lineEnd - snapshot.lineStart) * 100)) : 0;
  const { paired, secondaryActive, primary, secondary } = desktopContent(snapshot, style.verticalContent);
  const gap = paired ? desktopLineGap(style.fontSize, style.lineGap) : Math.max(3, Math.min(7, style.fontSize * .16));
  const highlightStyle = { clipPath: style.layout === 'vertical' ? `inset(0 0 ${100 - progress}% 0)` : `inset(0 ${100 - progress}% 0 0)` };

  useLayoutEffect(() => {
    const container = surface.current?.querySelector<HTMLElement>('.desktop-lyric-lines');
    const pair = surface.current?.querySelector<HTMLElement>('.desktop-lyric-pair');
    if (!container || !pair) return;
    const fit = () => {
      const padding = getComputedStyle(container);
      const width = container.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
      const height = container.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
      const next = Math.max(.001, Math.min(1, width / Math.max(1, pair.offsetWidth), height / Math.max(1, pair.offsetHeight)));
      setScale((previous) => Math.abs(previous - next) > .0001 ? next : previous);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    observer.observe(pair);
    fit();
    return () => observer.disconnect();
  }, [paired, style.layout]);

  return <main ref={surface} className={`desktop-lyrics-window desktop-theme-${style.theme} desktop-layout-${style.layout} desktop-pair-${paired ? 'next' : 'translation'} ${paired && !secondary ? 'desktop-single-line' : ''} ${hovered ? 'pointer-inside' : ''} ${hovered && !style.locked ? 'menu-open' : ''} ${style.locked ? 'locked' : ''}`} style={{ '--desktop-font-size': `${style.fontSize}px`, '--desktop-line-gap': `${gap}px`, '--desktop-opacity': style.opacity } as React.CSSProperties}>
    {!style.locked && <header className="desktop-toolbar" data-desktop-interactive="toolbar"><div className="desktop-drag-handle" title="拖动菜单移动歌词" aria-label="拖动菜单移动歌词"><GripVertical size={13} /></div><div className="desktop-window-controls">
      <button aria-label="返回主窗口" title="返回主窗口" data-tooltip="返回主窗口" onClick={() => window.tingyuDesktop?.control('show-main')}><Disc3 size={16} /></button>
      <button aria-label="上一首" title="上一首" data-tooltip="上一首" onClick={() => window.tingyuDesktop?.control('previous')}><SkipBack size={15} /></button>
      <button aria-label={snapshot?.playing ? '暂停' : '播放'} title={snapshot?.playing ? '暂停' : '播放'} data-tooltip={snapshot?.playing ? '暂停' : '播放'} onClick={() => window.tingyuDesktop?.control('play-pause')}>{snapshot?.playing ? <Pause size={15} /> : <Play size={15} />}</button>
      <button aria-label="下一首" title="下一首" data-tooltip="下一首" onClick={() => window.tingyuDesktop?.control('next')}><SkipForward size={15} /></button>
      <span className="desktop-toolbar-divider" />
      <button aria-label="减小字号" title="减小字号" data-tooltip="减小字号" onClick={() => void window.tingyuDesktop?.setStyle({ fontSize: style.fontSize - 2 })}><Minus size={15} /></button>
      <button aria-label="增大字号" title="增大字号" data-tooltip="增大字号" onClick={() => void window.tingyuDesktop?.setStyle({ fontSize: style.fontSize + 2 })}><Plus size={15} /></button>
      <button aria-label="锁定桌面歌词" title="锁定并开启鼠标穿透（Ctrl+Alt+L 解锁）" data-tooltip="锁定歌词" onClick={() => void window.tingyuDesktop?.setLocked(true)}><Lock size={14} /></button>
      <button aria-label="桌面歌词工具设置" title="桌面歌词工具设置" data-tooltip="歌词设置" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}><Settings2 size={15} /></button>
      <button aria-label="关闭桌面歌词" title="关闭桌面歌词" data-tooltip="关闭歌词" onClick={() => void window.tingyuDesktop?.setVisible(false)}><X size={16} /></button>
    </div></header>}
    {toolsOpen && hovered && !style.locked && <div className="desktop-tools-panel" role="group" aria-label="歌词工具设置" data-desktop-interactive="toolbar">
      <button aria-label="切换歌词颜色" title="切换歌词颜色" onClick={() => void window.tingyuDesktop?.setStyle({ theme: themes[(themes.indexOf(style.theme) + 1) % themes.length] })}><Palette size={15} /><span>切换颜色</span></button>
      <button aria-label={style.layout === 'vertical' ? '切换横排双行' : '切换竖排双列'} title={style.layout === 'vertical' ? '切换横排双行' : '切换竖排双列'} onClick={() => { setToolsOpen(false); void window.tingyuDesktop?.setStyle({ layout: style.layout === 'vertical' ? 'horizontal' : 'vertical' }); }}><Columns2 size={15} /><span>{style.layout === 'vertical' ? '切换横排' : '切换竖排'}</span></button>
      <button aria-label={style.verticalContent === 'next' ? '切换原文译文双列' : '切换当前句下一句'} title={style.verticalContent === 'next' ? '切换原文译文双列' : '切换当前句下一句'} onClick={() => void window.tingyuDesktop?.setStyle({ verticalContent: style.verticalContent === 'next' ? 'auto' : 'next' })}><Languages size={15} /><span>{style.verticalContent === 'next' ? '译文优先' : '双句交替'}</span></button>
      <button aria-label="桌面歌词设置" title="桌面歌词设置" onClick={() => window.tingyuDesktop?.control('settings')}><Settings2 size={15} /><span>完整设置</span></button>
    </div>}
    {style.locked && <button className="desktop-unlock" data-desktop-interactive="unlock" aria-label="解锁桌面歌词" title="解锁桌面歌词（Ctrl+Alt+L）" onClick={() => void window.tingyuDesktop?.setLocked(false)}><Unlock size={15} /><span>解锁</span></button>}
    <div className="desktop-lyric-lines"><div className="desktop-lyric-pair" style={{ transform: `scale(${scale})` }}><div className={`desktop-primary-line ${!secondaryActive ? 'is-current' : ''}`} title={primary}><span className="desktop-text-base">{primary}</span>{!secondaryActive && <span className="desktop-text-highlight" aria-hidden="true" style={highlightStyle}>{primary}</span>}</div><div className={`desktop-secondary-line ${secondaryActive ? 'is-current' : ''}`} title={secondary}><span className="desktop-text-base">{secondary}</span>{secondaryActive && <span className="desktop-text-highlight" aria-hidden="true" style={highlightStyle}>{secondary}</span>}</div></div></div>
  </main>;
}
