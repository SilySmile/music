import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import trust from '../../updates/public.json';
import manifest from '../../package.json';
export type UpdateConfig = { baseUrl: string; autoCheck: boolean; currentVersion: string; platform: string; configPath: string; downloadDirectory: string; lastChecked: number };
export type UpdateState = { phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'paused' | 'downloaded' | 'error'; currentVersion: string; platform: string; bytes: number; total: number; message: string; release?: { version: string; notes: string; issuedAt: string; size: number; kind: 'nsis' | 'portable' | 'apk' } };
interface UpdatesPlugin {
  config(): Promise<UpdateConfig>;
  saveConfig(value: { baseUrl: string; autoCheck: boolean }): Promise<UpdateConfig>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  pause(): Promise<UpdateState>;
  state(): Promise<UpdateState>;
  install(): Promise<{ installed?: boolean; permissionNeeded?: boolean; portable?: boolean; testVerified?: boolean }>;
  addListener(name: 'state', listener: (state: UpdateState) => void): Promise<PluginListenerHandle>;
}
const native = registerPlugin<UpdatesPlugin>('AppUpdates');
export const updatesSupported = () => !!window.tingyuDesktop || Capacitor.getPlatform() === 'android';
export const initialUpdateState = (): UpdateState => ({ phase: 'idle', currentVersion: manifest.version, platform: Capacitor.getPlatform() === 'android' ? 'android' : 'win-x64', bytes: 0, total: 0, message: '' });
export async function updateConfig(): Promise<UpdateConfig> {
  if (window.tingyuDesktop) return window.tingyuDesktop.updateConfig();
  if (Capacitor.getPlatform() === 'android') return native.config();
  return { baseUrl: trust.defaultBaseUrl, autoCheck: false, currentVersion: manifest.version, platform: 'preview', configPath: '', downloadDirectory: '', lastChecked: 0 };
}
export function saveUpdateConfig(value: { baseUrl: string; autoCheck: boolean }) { return window.tingyuDesktop ? window.tingyuDesktop.saveUpdateConfig(value) : native.saveConfig(value); }
export function checkUpdate() { return window.tingyuDesktop ? window.tingyuDesktop.checkUpdate() : native.check(); }
export function downloadUpdate() { return window.tingyuDesktop ? window.tingyuDesktop.downloadUpdate() : native.download(); }
export function pauseUpdate() { return window.tingyuDesktop ? window.tingyuDesktop.pauseUpdate() : native.pause(); }
export function currentUpdateState() { return window.tingyuDesktop ? window.tingyuDesktop.updateState() : native.state(); }
export function installUpdate() { return window.tingyuDesktop ? window.tingyuDesktop.installUpdate() : native.install(); }
export async function onUpdateState(listener: (state: UpdateState) => void) {
  if (window.tingyuDesktop) return window.tingyuDesktop.onUpdateState(listener);
  const handle = await native.addListener('state', listener); return () => { void handle.remove(); };
}
let startupAttempted = false;
export async function startupUpdateCheck() {
  if (startupAttempted || !updatesSupported()) return;
  startupAttempted = true;
  const config = await updateConfig();
  if (config.autoCheck && Date.now() - config.lastChecked >= 24 * 3600000) return checkUpdate();
}
