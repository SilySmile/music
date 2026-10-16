import type { DesktopSnapshot, DesktopStyle } from '../types';

export function desktopContent(snapshot: DesktopSnapshot | null, mode: DesktopStyle['verticalContent']) {
  const text = snapshot?.text || (snapshot?.title ? `♪ ${snapshot.title}` : '弦栖霁 · 等待播放');
  const translation = snapshot?.translation.trim() || '';
  const paired = mode === 'next' || (mode === 'auto' && !translation);
  const secondaryActive = paired && !!snapshot?.previousText && snapshot.lineIndex % 2 === 1;
  return {
    paired,
    secondaryActive,
    primary: secondaryActive ? snapshot!.previousText : text,
    secondary: paired ? secondaryActive ? text : snapshot?.nextText || '' : translation || '暂无中文译文',
  };
}

export function desktopLineGap(fontSize: number, gap: number) {
  return fontSize * Math.max(8, Math.min(48, gap)) / 8;
}
