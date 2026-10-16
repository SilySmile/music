import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const createShortcuts = createRequire(import.meta.url)('../../electron/shortcuts.cjs');
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) { expect(path.dirname(directory)).toBe(path.resolve('test-results')); expect(path.basename(directory)).toMatch(/^shortcuts-/); await fs.rm(directory, { recursive: true }); } });
describe('global keyboard shortcuts', () => {
  it('canonicalizes and validates combinations', () => {
    expect(createShortcuts.normalize('Alt+Control+p')).toBe('Ctrl+Alt+P');
    expect(createShortcuts.normalize('')).toBe('');
    for (const value of ['P', 'Ctrl+Ctrl+P', 'Ctrl+', 'Ctrl+PrintSomething']) expect(() => createShortcuts.normalize(value)).toThrow();
  });
  it('reports conflicts and duplicates, dispatches and persists registration settings', async () => {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    const directory = await fs.mkdtemp(path.resolve('test-results/shortcuts-')); directories.push(directory);
    const callbacks = new Map<string, () => void>();
    const globalShortcut = { register: vi.fn((key: string, callback: () => void) => { if (key === 'Ctrl+Alt+X') return false; callbacks.set(key, callback); return true; }), unregister: vi.fn((key: string) => callbacks.delete(key)) };
    const dispatch = vi.fn(); const shortcuts = createShortcuts({ directory, globalShortcut, dispatch });
    const initial = await shortcuts.load(); expect(initial.status['play-pause']).toBe('ok');
    callbacks.get('Ctrl+Alt+P')!(); expect(dispatch).toHaveBeenCalledWith('play-pause');
    initial.bindings.next = 'Ctrl+Alt+X'; initial.bindings.previous = initial.bindings['play-pause'];
    const saved = await shortcuts.save(initial); expect(saved.status.next).toBe('conflict'); expect(saved.status.previous).toBe('conflict');
    expect((await createShortcuts({ directory, globalShortcut, dispatch }).load()).bindings.next).toBe('Ctrl+Alt+X');
    const disabled = await shortcuts.save({ ...saved, enabled: false }); expect(Object.values(disabled.status).every((status) => status === 'disabled')).toBe(true);
  });
});
