import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import type { ShortcutConfig } from '../types';
const labels: Record<string, string> = { 'play-pause': '播放 / 暂停', previous: '上一首', next: '下一首', 'volume-up': '增大音量', 'volume-down': '减小音量', 'toggle-favorite': '添加 / 取消喜欢', 'show-main': '显示 / 隐藏音乐界面', 'desktop-toggle': '显示 / 隐藏桌面歌词', 'desktop-lock': '锁定 / 解锁桌面歌词', 'cycle-mode': '切换播放模式' };
export default function ShortcutSettings() {
  const [config, setConfig] = useState<ShortcutConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const bridge = window.tingyuDesktop;
  useEffect(() => { if (bridge) void bridge.getShortcuts().then(setConfig).catch((error) => setMessage(error.message)); }, [bridge]);
  async function save() {
    if (!config || !bridge) return;
    setSaving(true);
    try { const result = await bridge.saveShortcuts(config); setConfig(result); setDirty(false); setMessage(Object.values(result.status).includes('conflict') ? '已保存；标红的快捷键被其他程序占用或重复，请更换组合后重试。' : '已保存，全局快捷键即时生效。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '快捷键保存失败'); }
    finally { setSaving(false); }
  }
  return <section className="shortcut-settings"><h3><Keyboard size={16} />全局快捷键</h3>{!bridge ? <p className="field-help">全局组合键为 Windows 功能。安卓支持系统媒体控制；普通应用不能接管其他安卓应用的全局按键。</p> : <>
    <label className="remember-key"><input type="checkbox" disabled={!config || saving} checked={config?.enabled ?? false} onChange={(event) => { setConfig((previous) => previous && { ...previous, enabled: event.target.checked }); setDirty(true); }} />启用全局快捷键</label>
    {config && <div className="shortcut-list">{Object.entries(config.bindings).map(([action, accelerator]) => <label className="shortcut-row" key={action}><span>{labels[action] || action}</span><input aria-label={`${labels[action] || action}全局快捷键`} placeholder="点击后按组合键；退格清空" value={accelerator} disabled={saving} onChange={(event) => { setConfig({ ...config, bindings: { ...config.bindings, [action]: event.target.value } }); setDirty(true); }} onKeyDown={(event) => {
      if (event.key === 'Tab') return;
      event.preventDefault();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      const clear = event.key === 'Backspace' || event.key === 'Escape';
      const key = event.key.startsWith('Arrow') ? event.key.slice(5) : event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
      const value = clear ? '' : [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.metaKey ? ['Super'] : []), key].join('+');
      setConfig({ ...config, bindings: { ...config.bindings, [action]: value } }); setDirty(true);
    }} /><em className={!dirty && config.status[action] === 'conflict' ? 'conflict' : ''}>{dirty ? '待保存' : config.status[action] === 'ok' ? '正常' : config.status[action] === 'conflict' ? '冲突' : '未启用'}</em></label>)}</div>}
    <div className="storage-buttons"><button className="button outline" disabled={!config || saving} onClick={() => void save()}>保存并应用快捷键</button><button className="text-button" disabled={saving} onClick={() => void bridge.defaultShortcuts().then((defaults) => { setConfig({ ...defaults, status: {}, path: config?.path || '' }); setDirty(true); })}>恢复默认</button></div>
    <p className="field-help" role="status">{message || '点击输入框并按组合键；退格清空，保存后检查真实系统注册状态。托盘隐藏时同样有效。'}{config?.path && <><br />配置文件：<code>{config.path}</code></>}</p>
  </>}</section>;
}
