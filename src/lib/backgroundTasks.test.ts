import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ platform: 'web', begin: vi.fn(), finish: vi.fn(), update: vi.fn(), addListener: vi.fn(), pauseSource: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => bridge.platform }, registerPlugin: () => bridge }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); bridge.platform = 'web';
  bridge.begin.mockResolvedValue(undefined); bridge.finish.mockResolvedValue(undefined); bridge.update.mockResolvedValue(undefined); bridge.addListener.mockResolvedValue({ remove: vi.fn() });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
describe('application-lifetime background tasks', () => {
  it('owns one run per id, pauses explicitly and releases its service lease', async () => {
    bridge.platform = 'android';
    const tasks = await import('./backgroundTasks');
    const job = await tasks.beginBackgroundTask({ id: 'test-job', title: '下载测试', view: 'settings' });
    expect(bridge.begin).toHaveBeenCalledWith({ id: 'test-job', title: '下载测试' });
    await expect(tasks.beginBackgroundTask({ id: 'test-job', title: '重复', view: 'settings' })).rejects.toThrow('后台运行');
    job.progress('完成 1 / 2'); tasks.pauseBackgroundTask('test-job');
    expect(job.signal.aborted).toBe(true);
    await job.finish('paused', '检查点保留'); await job.finish();
    expect(tasks.backgroundRunning()).toBe(false); expect(bridge.finish).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('xianqiji-background-tasks-v1')!)[0].status).toBe('paused');
  });
  it('cleans failed native starts and interruption during start without leaking a lease', async () => {
    bridge.platform = 'android'; bridge.begin.mockRejectedValueOnce(new Error('Permission denied'));
    const tasks = await import('./backgroundTasks');
    await expect(tasks.beginBackgroundTask({ id: 'refused', title: '测试', view: 'export' })).rejects.toThrow('Permission');
    expect(tasks.backgroundRunning()).toBe(false);
    const controller = new AbortController(); bridge.begin.mockImplementationOnce(async () => { controller.abort(); });
    await expect(tasks.beginBackgroundTask({ id: 'aborted', title: '测试', view: 'export', signal: controller.signal })).rejects.toThrow();
    expect(tasks.backgroundRunning()).toBe(false);
    expect(bridge.finish).toHaveBeenCalledWith({ id: 'aborted' });
  });
  it('pauses all jobs, prevents automatic paid retries and restores interrupted tasks without running them', async () => {
    const tasks = await import('./backgroundTasks');
    const first = await tasks.beginBackgroundTask({ id: 'first', title: 'AI 歌词', view: 'online' });
    const second = await tasks.beginBackgroundTask({ id: 'second', title: '导出', view: 'export' });
    tasks.pauseBackgroundTasks(); expect(first.signal.aborted && second.signal.aborted).toBe(true);
    await first.finish('paused'); await second.finish('paused');
    await expect(tasks.beginBackgroundTask({ id: 'paid-retry', title: 'AI', view: 'online' })).rejects.toThrow('已暂停');
    tasks.resumeBackgroundTasks();
    await tasks.beginBackgroundTask({ id: 'interrupted', title: 'AI 原请求', view: 'online' });
    vi.resetModules(); const restored = await import('./backgroundTasks'); restored.restoreBackgroundTasks();
    expect(restored.backgroundRunning()).toBe(false); expect(bridge.begin).not.toHaveBeenCalled();
    const journal = JSON.parse(localStorage.getItem('xianqiji-background-tasks-v1')!);
    expect(journal.find((task: { id: string }) => task.id === 'interrupted').status).toBe('paused');
  });
});
