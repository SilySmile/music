import { Capacitor, registerPlugin } from '@capacitor/core';
const native = registerPlugin<{ loadKey(): Promise<{ key: string; path: string }>; saveKey(options: { key: string }): Promise<void>; clearKey(): Promise<void> }>('SecureConfig');
export const canRememberKey = () => !!window.tingyuDesktop || Capacitor.isNativePlatform();
export async function loadSavedKey(): Promise<{ key: string; forcedKey?: string; path: string }> {
  const unpack = (value: { key: string; path: string }) => {
    try { const bundle = JSON.parse(value.key); if (bundle.format === 'xianqiji-keys-v2' && typeof bundle.translation === 'string' && typeof bundle.forced === 'string') return { ...value, key: bundle.translation, forcedKey: bundle.forced }; } catch { /* Legacy plain encrypted key. */ }
    return value;
  };
  if (window.tingyuDesktop) {
    const [key, info] = await Promise.all([window.tingyuDesktop.getAIKey(), window.tingyuDesktop.getLibraryInfo()]);
    return unpack({ key, path: `${info.internalPath}\\ai-config.json` });
  }
  if (Capacitor.isNativePlatform()) return unpack(await native.loadKey());
  return { key: '', path: '' };
}
export async function persistKey(translation: string, remember: boolean, forced = '') {
  const key = forced ? JSON.stringify({ format: 'xianqiji-keys-v2', translation, forced }) : translation;
  if (window.tingyuDesktop) {
    if (remember && key) await window.tingyuDesktop.saveAIKey(key);
    else await window.tingyuDesktop.clearAIKey();
  } else if (Capacitor.isNativePlatform()) {
    if (remember && key) await native.saveKey({ key }); else await native.clearKey();
  }
}
