interface SyncHandle { getSize(): number; write(data: Uint8Array, options: { at?: number }): number; flush(): void; truncate(size: number): void; close(): void }
const workerScope = self as unknown as { onmessage: ((event: MessageEvent<{ command: string; id?: string; offset?: number; data?: Uint8Array; size?: number }>) => Promise<void>) | null; postMessage(value: unknown): void };
let handle: SyncHandle | undefined;
workerScope.onmessage = async (event: MessageEvent<{ command: string; id?: string; offset?: number; data?: Uint8Array; size?: number }>) => {
  try {
    const request = event.data;
    if (request.command === 'open') {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(`${request.id}.zip`, { create: true });
      handle = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      workerScope.postMessage({ size: handle.getSize() });
    } else if (request.command === 'write') {
      if (!handle || !request.data) throw new Error('文件未打开');
      const written = handle.write(request.data, { at: request.offset });
      if (written !== request.data.length) throw new Error('存储空间不足');
      handle.flush(); workerScope.postMessage({});
    } else {
      if (request.command === 'finish' && handle) handle.truncate(request.size ?? 0);
      handle?.flush(); handle?.close(); handle = undefined;
      workerScope.postMessage({});
    }
  } catch (error) { workerScope.postMessage({ error: error instanceof Error ? error.message : '本地文件写入失败' }); }
};
