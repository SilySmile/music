import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';
import { defaultForcedConfig, type ForcedHealth } from './forcedAlignment';
import { forcedTaskKey, runForcedQueue } from './forcedAlignmentQueue';
const config = { ...defaultForcedConfig, key: 'fixture-only-key', automatic: true };
const health: ForcedHealth = { service: 'xianqiji-forced-aligner', protocol: 1, model: config.model, ready: true, resource_ready: true, concurrency: 2 };
const song = (id: string): Track => ({ id, title: id, artist: '', album: '', duration: 10, format: 'wav', audio: new Blob(['fixture']), favorite: false, addedAt: 1, lyrics: [{ time: 1, text: '你好' }] });
const aligned = (track: Track) => ({ lyrics: [{ ...track.lyrics[0], endTime: 4, words: [{ text: '你', time: 1, endTime: 2 }, { text: '好', time: 3, endTime: 4 }] }], matched: 1, unmatched: 0, existing: 0 });
const base = () => ({ tracks: [song('a'), song('b'), song('c')], config, signal: new AbortController().signal, scope: 'library-a', attempted: new Set<string>(), remember: vi.fn(), currentScope: async () => 'library-a', save: vi.fn(async () => {}), progress: vi.fn(), health: vi.fn(async () => health) });
describe('bounded local forced alignment queue', () => {
  it('uses at most two workers and persists completed source checkpoints', async () => {
    const options = base(); let active = 0, peak = 0;
    await runForcedQueue({ ...options, generate: async (track) => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return aligned(track); } });
    expect(peak).toBe(2); expect(options.save).toHaveBeenCalledTimes(3);
    expect(options.attempted.has(forcedTaskKey(song('a'), options.scope, config))).toBe(true);
    const generate = vi.fn(); await runForcedQueue({ ...options, generate }); expect(generate).not.toHaveBeenCalled();
  });
  it('waits before materializing audio under resource pressure and honors a one-song limit', async () => {
    const options = base(); const generate = vi.fn();
    await runForcedQueue({ ...options, generate, health: async () => ({ ...health, resource_ready: false, reason: '显存不足' }) });
    expect(generate).not.toHaveBeenCalled(); expect(options.attempted.size).toBe(0);
    let active = 0, peak = 0;
    await runForcedQueue({ ...options, config: { ...config, concurrency: 1 }, generate: async (track) => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return aligned(track); } });
    expect(peak).toBe(1);
  });
  it('retains unmatched checkpoints after partial saves and does not loop on provider errors', async () => {
    const options = base(); const track = options.tracks[0];
    const partial = { ...aligned(track), unmatched: 1 };
    await runForcedQueue({ ...options, tracks: [track], generate: async () => partial });
    const generate = vi.fn(); await runForcedQueue({ ...options, tracks: [{ ...track, lyrics: partial.lyrics }], generate });
    expect(generate).not.toHaveBeenCalled();
    await runForcedQueue({ ...options, tracks: [song('invalid')], generate: async () => { throw new Error('原文不符'); } });
    expect(options.attempted.has(forcedTaskKey(song('invalid'), options.scope, config))).toBe(true);
    await runForcedQueue({ ...options, tracks: [song('busy')], generate: async () => { throw new Error('HTTP 503'); } });
    expect(options.attempted.has(forcedTaskKey(song('busy'), options.scope, config))).toBe(false);
  });
  it('cancels before saving and never writes into a changed library', async () => {
    const options = base(); const controller = new AbortController();
    await expect(runForcedQueue({ ...options, signal: controller.signal, generate: async (track) => { controller.abort(); return aligned(track); } })).rejects.toThrow();
    expect(options.save).not.toHaveBeenCalled();
    await expect(runForcedQueue({ ...base(), save: options.save, currentScope: async () => 'other-library', generate: async (track) => aligned(track) })).rejects.toThrow('音乐库已改变');
    expect(options.save).not.toHaveBeenCalled();
  });
  it('distinguishes library, source and model changes but ignores translation and secrets', () => {
    const track = song('a'); const first = forcedTaskKey(track, 'library-a', config);
    expect(forcedTaskKey({ ...track, lyrics: [{ ...track.lyrics[0], translation: 'Hello' }] }, 'library-a', { ...config, key: 'different' })).toBe(first);
    expect(forcedTaskKey(track, 'library-b', config)).not.toBe(first);
    expect(forcedTaskKey(track, 'library-a', { ...config, model: 'new' })).not.toBe(first);
  });
});
