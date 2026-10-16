import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioFader, nextMode, nextTrackId } from './playback';

afterEach(() => { vi.useRealTimers(); });
function player() {
  const audio = { paused: true, ended: false, volume: 0.7, play: vi.fn(async () => { audio.paused = false; }), pause: vi.fn(() => { audio.paused = true; }) };
  let volume = 0.7;
  const fader = createAudioFader(audio as unknown as HTMLAudioElement, () => volume, () => 500);
  return { audio, fader, setVolume: (value: number) => { volume = value; fader.setVolume(); } };
}
describe('playback order and volume envelopes', () => {
  it('cycles modes and advances, wraps and avoids shuffle repeats', () => {
    expect(nextMode(nextMode(nextMode('list')))).toBe('list');
    expect(nextTrackId(['a', 'b', 'c'], 'a', 1, 'list', true)).toBe('b');
    expect(nextTrackId(['a', 'b', 'c'], 'c', 1, 'list', true)).toBe('a');
    expect(nextTrackId(['a', 'b'], 'a', 1, 'one', true)).toBe('a');
    expect(nextTrackId(['a', 'b'], 'a', 1, 'one', false)).toBe('b');
    expect(nextTrackId(['a', 'b'], 'a', 1, 'shuffle', true, () => 0)).toBe('b');
    expect(nextTrackId([], 'a', 1, 'list')).toBeUndefined();
  });
  it('fades in / out without changing the configured volume', async () => {
    vi.useFakeTimers(); const { audio, fader, setVolume } = player();
    await fader.play(); expect(audio.volume).toBe(0);
    vi.advanceTimersByTime(256); expect(audio.volume).toBeGreaterThan(0); expect(audio.volume).toBeLessThan(0.7);
    vi.advanceTimersByTime(300); expect(audio.volume).toBeCloseTo(0.7);
    fader.pause(); vi.advanceTimersByTime(256); expect(audio.paused).toBe(false); expect(audio.volume).toBeLessThan(0.7);
    vi.advanceTimersByTime(300); expect(audio.paused).toBe(true); expect(audio.volume).toBeCloseTo(0.7);
    setVolume(0.3); await fader.play(); vi.advanceTimersByTime(550); expect(audio.volume).toBeCloseTo(0.3); fader.dispose();
  });
  it('interrupts a pending pause when resumed, and supports an immediate sleep stop', async () => {
    vi.useFakeTimers(); const { audio, fader } = player();
    await fader.play(); vi.advanceTimersByTime(550);
    fader.pause(); vi.advanceTimersByTime(100); await fader.play(); vi.advanceTimersByTime(600);
    expect(audio.paused).toBe(false); expect(audio.volume).toBeCloseTo(0.7);
    fader.pause(true); expect(audio.paused).toBe(true); expect(audio.volume).toBeCloseTo(0.7); fader.dispose();
  });
  it('does not let a late rejection from cancelled play overwrite the current intent', async () => {
    vi.useFakeTimers(); const { audio, fader } = player();
    let reject: (error: Error) => void = () => {};
    audio.play.mockImplementationOnce(() => new Promise((_, failure) => { reject = failure; }));
    const first = fader.play(); fader.pause(true); await fader.play(); reject(new Error('interrupted')); await first;
    vi.advanceTimersByTime(600); expect(audio.paused).toBe(false); expect(fader.isPlaying()).toBe(true); fader.dispose();
  });
});
