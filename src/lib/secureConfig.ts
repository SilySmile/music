import { Capacitor, registerPlugin } from '@capacitor/core';
const native = registerPlugin<{ loadKey(): Promise<{ key: string; path: string }>; saveKey(options: { key: string }): Promise<void>; clearKey(): Promise<void> }>('SecureConfig');
export const canRememberKey = () => !!window.tingyuDesktop || Capacitor.isNativePlatform();
export async function loadSavedKey(): Promise<{ key: string; path: string }> {
  if (window.tingyuDesktop) {
    const [key, info] = await Promise.all([window.tingyuDesktop.getAIKey(), window.tingyuDesktop.getLibraryInfo()]);
    return { key, path: `${info.internalPath}\\ai-config.json` };
  }
  if (Capacitor.isNativePlatform()) return native.loadKey();
  return { key: '', path: '' };
}
export async function persistKey(key: string, remember: boolean) {
  if (window.tingyuDesktop) {
    if (remember && key) await window.tingyuDesktop.saveAIKey(key);
    else await window.tingyuDesktop.clearAIKey();
  } else if (Capacitor.isNativePlatform()) {
    if (remember && key) await native.saveKey({ key }); else await native.clearKey();
  }
}
