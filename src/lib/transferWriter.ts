import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ExportTask } from './transferTypes';

interface NativeTransferFiles {
  open(options: { id: string }): Promise<{ location: string; size: number }>;
  write(options: { id: string; offset: number; data: string }): Promise<void>;
  finish(options: { id: string; size: number }): Promise<{ location: string }>;
  saveAs(options: { id: string; filename: string }): Promise<{ location: string }>;
}
const nativeFiles = registerPlugin<NativeTransferFiles>('TransferFiles');

export async function openTransferWriter(task: ExportTask) {
  if (window.tingyuDesktop) {
    const bridge = window.tingyuDesktop;
    const output = await bridge.openExport(task.id, task.filename, true);
    if (output.size < task.checkpoint.offset) throw new Error('目标文件不完整，请恢复原文件或新建导出任务。');
    return { location: output.location, write: (offset: number, data: Uint8Array) => bridge.writeExport(task.id, offset, data), finish: (size: number) => bridge.finishExport(task.id, size), close: async () => {} };
  }
  if (Capacitor.isNativePlatform()) {
    const output = await nativeFiles.open({ id: task.id });
    if (output.size < task.checkpoint.offset) throw new Error('导出临时文件已丢失，请新建导出任务。');
    return {
      location: output.location,
      write: async (offset: number, data: Uint8Array) => {
        let binary = '';
        for (let index = 0; index < data.length; index += 8192) binary += String.fromCharCode(...data.subarray(index, index + 8192));
        await nativeFiles.write({ id: task.id, offset, data: btoa(binary) });
      },
      finish: async (size: number) => (await nativeFiles.finish({ id: task.id, size })).location,
      close: async () => {},
    };
  }
  if (!navigator.storage?.getDirectory) throw new Error('此浏览器不支持可恢复的大文件导出，请使用 PC 或安卓客户端。');
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
  let closed = false;
  const send = (message: object) => new Promise<{ size?: number }>((resolve, reject) => {
    worker.onmessage = (event) => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    worker.onerror = () => reject(new Error('此浏览器无法打开分块写入服务，请使用客户端。'));
    worker.postMessage(message);
  });
  let opened: { size?: number };
  try { opened = await send({ command: 'open', id: task.id }); }
  catch (error) { worker.terminate(); throw error; }
  if ((opened.size ?? 0) < task.checkpoint.offset) { worker.terminate(); throw new Error('导出临时文件已清理，请新建任务。'); }
  return {
    location: `opfs:${task.id}`,
    write: async (offset: number, data: Uint8Array) => { await send({ command: 'write', offset, data }); },
    finish: async (size: number) => { await send({ command: 'finish', size }); closed = true; worker.terminate(); return `opfs:${task.id}`; },
    close: async () => { if (closed) return; try { await send({ command: 'close' }); } finally { closed = true; worker.terminate(); } },
  };
}

export async function presentExport(task: ExportTask) {
  if (window.tingyuDesktop) { await window.tingyuDesktop.revealExport(task.id); return; }
  if (Capacitor.isNativePlatform()) {
    await nativeFiles.saveAs({ id: task.id, filename: task.filename });
    return;
  }
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(`${task.id}.zip`);
  const file = await handle.getFile();
  const url = URL.createObjectURL(file);
  const link = document.createElement('a'); link.href = url; link.download = task.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
