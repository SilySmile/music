import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SourceTransferTask } from './transferTypes';

interface NativeSourceDownloads {
  begin(options: { id: string; title: string }): Promise<void>;
  update(options: { id: string; message: string }): Promise<void>;
  finish(options: { id: string }): Promise<void>;
  openPowerSettings(): Promise<void>;
  downloadSource(options: { task: SourceTransferTask; baseUrl: string; token: string }): Promise<SourceTransferTask>;
  sourceTasks(): Promise<{ tasks: SourceTransferTask[] }>;
  pauseSource(options: { id: string }): Promise<void>;
  forgetSource(options: { id: string }): Promise<void>;
  addListener(event: 'sourceProgress', listener: (task: SourceTransferTask) => void): Promise<PluginListenerHandle>;
  addListener(event: 'control', listener: (event: { action: string; reason?: string }) => void): Promise<PluginListenerHandle>;
}
export const nativeSourceDownloads = registerPlugin<NativeSourceDownloads>('BackgroundTasks');
export const nativeSourceEnabled = (scope: string) => Capacitor.getPlatform() === 'android' && scope.startsWith('folder:');
export function validNativeSourceTask(value: SourceTransferTask): boolean {
  if (!value || value.kind !== 'source' || value.direction !== 'download' || value.nativeDownload !== true || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || typeof value.label !== 'string' || typeof value.scope !== 'string' || !value.scope.startsWith('folder:') || typeof value.sourceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceIdentity) || !Number.isFinite(value.updatedAt) || !['running', 'paused', 'failed', 'completed'].includes(value.status)) return false;
  if (!Array.isArray(value.ids) || !value.ids.length || !value.ids.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) || !Array.isArray(value.completed)) return false;
  const identifiers = new Set(value.ids);
  return identifiers.size === value.ids.length && new Set(value.completed).size === value.completed.length && value.completed.every((id) => identifiers.has(id)) && (value.status !== 'completed' || value.completed.length === value.ids.length);
}
