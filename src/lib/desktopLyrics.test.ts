import { describe, expect, it } from 'vitest';
import { desktopContent, desktopLineGap } from './desktopLyrics';
import type { DesktopSnapshot } from '../types';

const snapshot: DesktopSnapshot = { title: 'Quiet Room', artist: 'Demo', text: 'A quiet room', translation: '一间静谧的房间', previousText: 'Soft light', nextText: 'Stay here', lineIndex: 1, lineStart: 5, lineEnd: 8, position: 6, duration: 36, playing: false, showTranslation: false, favorite: false, hasTrack: true, volume: 1, mode: 'list' };

describe('desktop bilingual content and spacing', () => {
  it('keeps the current source with its Chinese even when main-window translation is off', () => {
    expect(desktopContent(snapshot, 'auto')).toEqual({ paired: false, secondaryActive: false, primary: snapshot.text, secondary: snapshot.translation });
    expect(desktopContent({ ...snapshot, lineIndex: 0 }, 'auto')).toMatchObject({ primary: snapshot.text, secondary: snapshot.translation });
  });
  it('keeps two source slots when explicitly selected or no translation exists', () => {
    for (const content of [desktopContent(snapshot, 'next'), desktopContent({ ...snapshot, translation: '' }, 'auto')]) {
      expect(content).toMatchObject({ paired: true, secondaryActive: true, primary: snapshot.previousText, secondary: snapshot.text });
    }
    expect(desktopContent({ ...snapshot, lineIndex: 0, translation: '' }, 'auto').secondary).toBe(snapshot.nextText);
  });
  it('does not pass another source line off as a missing translation', () => {
    expect(desktopContent({ ...snapshot, translation: '  ' }, 'translation').secondary).toBe('暂无中文译文');
    expect(desktopContent(null, 'auto').primary).toContain('等待播放');
  });
  it('leaves three character widths after the source endpoint by default and scales with text', () => {
    expect(desktopLineGap(34, 24)).toBe(102);
    expect(desktopLineGap(20, 24)).toBe(60);
    expect(desktopLineGap(60, 48)).toBe(360);
    expect(desktopLineGap(14, 8)).toBe(14);
  });
});
