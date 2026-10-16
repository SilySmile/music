import 'fake-indexeddb/auto';
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createExportTask, createImportTask, filesFingerprint, runImportTask } from './transfers';
import { getTracks, getTransfers } from './storage';

describe('durable import tasks', () => {
  it('commits songs and checkpoints together and restores from a newly loaded task', async () => {
    const bytes = await fs.readFile('public/demo/弦栖霁示例.zip');
    const files = [new File([bytes], 'task-resume.zip', { lastModified: 123456 })];
    const task = await createImportTask(files);
    const controller = new AbortController();
    await runImportTask(task, files, controller.signal, (message) => { if (message.includes('正在导入 2 /')) controller.abort(); });
    expect(task.status).toBe('paused');
    expect(task.completed).toHaveLength(1);
    expect(await getTracks()).toHaveLength(1);
    const recovered = (await getTransfers()).find((item) => item.id === task.id);
    if (!recovered || recovered.kind !== 'import') throw new Error('Missing saved task');
    expect(recovered.completed).toEqual(task.completed);
    await runImportTask(recovered, files, new AbortController().signal, () => {});
    expect(recovered.status).toBe('completed');
    expect(recovered.completed).toHaveLength(3);
    expect(await getTracks()).toHaveLength(3);
  });
  it('refuses an unrelated or modified source instead of skipping arbitrary songs', async () => {
    const first = [new File(['original'], 'same.zip', { lastModified: 100 })];
    const different = [new File(['modified'], 'same.zip', { lastModified: 100 })];
    expect(await filesFingerprint(first)).not.toBe(await filesFingerprint(different));
    const task = await createImportTask(first);
    await expect(runImportTask(task, different, new AbortController().signal, () => {})).rejects.toThrow('不一致');
  });
  it('uses only the current product name in exported instructions while retaining the compatible file format', async () => {
    const tracks = await getTracks();
    const task = await createExportTask(tracks);
    const instructions = task.entries.find((entry) => entry.name === '导入说明.txt');
    expect(instructions?.source.type).toBe('text');
    if (instructions?.source.type !== 'text') throw new Error('Missing export instructions');
    expect(instructions.source.text).toContain('弦栖霁');
    expect(instructions.source.text).toContain('兼容旧版音乐包');
    expect(instructions.source.text).not.toContain('\u542c\u5c7f');
    expect(task.entries.some((entry) => entry.name.endsWith('/tingyu-library.json'))).toBe(true);
  });
});
