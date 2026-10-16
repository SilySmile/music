import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const createDesktopPointer = createRequire(import.meta.url)('../../electron/desktop-pointer.cjs');

function fixture() {
  const state = { visible: true, locked: false };
  const cursor = { x: -1900, y: 240 };
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: -1920, y: 200, width: 920, height: 180 }),
    setIgnoreMouseEvents: vi.fn(),
    webContents: { send: vi.fn(), getZoomFactor: () => 1 },
  };
  const pointer = createDesktopPointer({ getWindow: () => window, getState: () => state, getCursor: () => cursor });
  pointer.setRegions([{ kind: 'toolbar', x: 12, y: 2, width: 896, height: 32 }, { kind: 'unlock', x: 10, y: 75, width: 70, height: 30 }]);
  return { pointer, state, cursor, window };
}

describe('desktop lyric native mouse handling', () => {
  it('shows the hover frame while lyric text and empty space pass clicks through', () => {
    const { pointer, window, cursor } = fixture();
    expect(pointer.update()).toEqual({ inside: true, interactive: false });
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(window.webContents.send).toHaveBeenLastCalledWith('desktop:pointer', true);
    cursor.y = 300;
    expect(pointer.update()).toEqual({ inside: true, interactive: false });
  });

  it('only captures the toolbar, then resumes passing clicks through on leave', () => {
    const { pointer, window, cursor } = fixture();
    cursor.y = 205;
    expect(pointer.update()).toEqual({ inside: true, interactive: true });
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    cursor.x = -1921;
    expect(pointer.update()).toEqual({ inside: false, interactive: false });
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(window.webContents.send).toHaveBeenLastCalledWith('desktop:pointer', false);
  });

  it('disables stale toolbar hit regions immediately when locked and keeps unlock clickable', () => {
    const { pointer, state, cursor } = fixture();
    cursor.y = 205;
    expect(pointer.update().interactive).toBe(true);
    state.locked = true;
    expect(pointer.update().interactive).toBe(false);
    cursor.y = 280;
    expect(pointer.update().interactive).toBe(true);
    cursor.x = -1800;
    expect(pointer.update().interactive).toBe(false);
  });

  it('never captures clicks or reports hover while the lyrics are hidden', () => {
    const { pointer, state, cursor } = fixture();
    cursor.y = 205;
    state.visible = false;
    expect(pointer.update()).toEqual({ inside: false, interactive: false });
  });

  it('matches the toolbar after browser zoom without expanding the lyric click area', () => {
    const { pointer, window, cursor } = fixture();
    window.webContents.getZoomFactor = () => 2;
    cursor.x = -1880;
    expect(pointer.update().interactive).toBe(true);
    cursor.y = 300;
    expect(pointer.update().interactive).toBe(false);
  });

  it('ignores invalid regions and keeps the frame edges outside the clickable area', () => {
    const { pointer, cursor } = fixture();
    pointer.setRegions([{ kind: 'toolbar', x: 0, y: 0, width: NaN, height: 180 }, { kind: 'lyric', x: 0, y: 0, width: 920, height: 180 }, null]);
    expect(pointer.update().interactive).toBe(false);
    cursor.x = -1000;
    expect(pointer.update().inside).toBe(false);
    pointer.reset();
    cursor.x = -1900;
    expect(pointer.update().interactive).toBe(false);
  });
});
