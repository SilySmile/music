import { useEffect, useState } from 'react';
import { PanelTopClose } from 'lucide-react';
import type { AppPreferences } from '../types';

export default function CloseSettings({ onError }: { onError(message: string): void }) {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const bridge = window.tingyuDesktop;
    if (!bridge) return;
    void bridge.getPreferences().then(setPreferences).catch(() => onError('关闭方式读取失败。'));
    return bridge.onPreferences(setPreferences);
  }, [onError]);

  async function save(closeAction: AppPreferences['closeAction']) {
    const previous = preferences;
    setPreferences({ closeAction });
    setSaving(true);
    try {
      const value = await window.tingyuDesktop?.setPreferences({ closeAction });
      if (value) setPreferences(value);
    } catch { setPreferences(previous); onError('关闭方式保存失败，请重试。'); }
    finally { setSaving(false); }
  }

  if (!preferences) return null;
  return <section className="close-settings"><h3><PanelTopClose size={16} />关闭主面板</h3><div className="close-choices" role="radiogroup" aria-label="关闭主面板">
    <label><input type="radio" name="close-action" checked={preferences.closeAction === 'tray'} disabled={saving} onChange={() => void save('tray')} /><span><strong>最小化到托盘，不退出程序</strong><small>继续播放，点击右下角托盘图标恢复窗口</small></span></label>
    <label><input type="radio" name="close-action" checked={preferences.closeAction === 'quit'} disabled={saving} onChange={() => void save('quit')} /><span><strong>退出程序</strong><small>关闭主窗口时直接结束应用和播放</small></span></label>
  </div><p className="field-help" aria-live="polite">{saving ? '正在保存…' : '自动保存，右上角关闭按钮按此设置执行，不再弹窗。'}</p></section>;
}
