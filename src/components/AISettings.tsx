import { useEffect, useState } from 'react';
import { Bot, Check, Eye, EyeOff } from 'lucide-react';
import type { AIConfig } from '../types';
import { normalizeAIUrl } from '../lib/network';
import { canRememberKey, loadSavedKey } from '../lib/secureConfig';

export default function AISettings({ config, onSave }: { config: AIConfig; onSave(config: AIConfig, remember: boolean): Promise<void> }) {
  const [draft, setDraft] = useState(config);
  const [remember, setRemember] = useState(() => canRememberKey() && localStorage.getItem('tingyu-remember-key') !== 'false');
  const [dirty, setDirty] = useState(false);
  const [keyPath, setKeyPath] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!dirty) setDraft(config); }, [config, dirty]);
  useEffect(() => { void loadSavedKey().then((result) => setKeyPath(result.path)).catch((error) => setStatus(error.message)); }, []);
  const change = <Key extends keyof AIConfig>(key: Key, value: AIConfig[Key]) => { setDirty(true); setDraft((previous) => ({ ...previous, [key]: value })); setStatus(''); };
  async function save() {
    setSaving(true);
    try {
      normalizeAIUrl(draft.url);
      if (!draft.model.trim()) throw new Error('请填写模型名称。');
      const next = { url: draft.url.trim(), key: draft.key.trim(), model: draft.model.trim() };
      await onSave(next, remember);
      localStorage.setItem('tingyu-remember-key', String(remember));
      setDirty(false);
      setDraft(next);
      setStatus('配置已保存；保存配置不会调用模型或消耗 token。');
    } catch (error) { setStatus(error instanceof Error ? error.message : '配置保存失败。'); }
    finally { setSaving(false); }
  }
  return <section className="ai-settings"><h3><Bot size={16} />AI 翻译配置</h3><div className="config-fields"><label>服务地址<input value={draft.url} onChange={(event) => change('url', event.target.value)} placeholder="https://api.deepseek.com" spellCheck={false} aria-label="AI 服务地址" /></label><label>模型名称<input value={draft.model} onChange={(event) => change('model', event.target.value)} placeholder="deepseek-flash" spellCheck={false} aria-label="AI 模型名称" /></label><label className="key-field">API Key<div><input type={showKey ? 'text' : 'password'} value={draft.key} onChange={(event) => change('key', event.target.value)} autoComplete="off" spellCheck={false} aria-label="翻译 API Key" placeholder="在本机填写你的密钥" /><button aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label></div>
    <p className="field-help">系统自动安排翻译与复核。每次明确歌名、歌手和上下文，核对行号与原文后才保存；不需要设置预算、句数或输出上限。</p><p className="field-help">相同歌曲的重复句去重并复用已核对缓存，不上传音频。AI 复核不是人工审校，译文可在核对表中修改；已提交的请求仍可能计费。</p>
    {canRememberKey() && <label className="remember-key"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />在这台设备上加密保存密钥（推荐）</label>}
    {keyPath && <p className="field-help">加密配置文件：<code>{keyPath}</code><br />Windows 使用当前账户系统加密；安卓使用 Android Keystore，解密用的系统密钥不写入此文件、不随音乐包导出。换设备或卸载后可能需要重新填写。</p>}
    <div className="config-save"><button className="button outline" disabled={saving} onClick={() => void save()}><Check size={14} />保存翻译配置</button><span role="status">{status || (canRememberKey() ? '默认加密保存，重启自动读取；取消勾选并保存会清除已存密钥。' : '浏览器预览不支持系统加密，密钥仅在本次运行中使用。')}</span></div>
  </section>;
}
