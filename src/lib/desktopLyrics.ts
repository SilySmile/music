import type { DesktopSnapshot, DesktopStyle } from '../types';

export function desktopContent(snapshot: DesktopSnapshot | null, mode: DesktopStyle['verticalContent']) {
  const text = snapshot?.text || (snapshot?.title ? `♪ ${snapshot.title}` : '弦栖霁 · 等待播放');
  const translation = snapshot?.translation.trim() || '';
  const paired = mode === 'next' || (mode === 'auto' && !translation);
  const next = snapshot?.nextText || '';
  // Keep the singing line in its alternating slot and immediately replace
  // the finished line with the upcoming one, rather than paging in pairs.
  const secondaryActive = paired && !!next && snapshot!.lineIndex % 2 === 1;
  return {
    paired,
    secondaryActive,
    primary: secondaryActive ? next : text,
    secondary: paired ? secondaryActive ? text : next : translation || '暂无中文译文',
  };
}

export function desktopLineGap(fontSize: number, gap: number) {
  return fontSize * Math.max(8, Math.min(48, gap)) / 8;
}
