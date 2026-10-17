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
      const next: AIConfig = { url: draft.url.trim(), key: draft.key.trim(), model: draft.model.trim(), audioModel: draft.audioModel?.trim() || 'whisper-1', autoAlign: false, alignmentMode: draft.alignmentMode === 'audio' ? 'audio' : 'text', singingHint: draft.singingHint?.trim().slice(0, 1200) || '' };
      await onSave(next, remember);
      localStorage.setItem('tingyu-remember-key', String(remember));
      setDirty(false);
      setDraft(next);
      setStatus('配置已保存。逐字时间请在歌词设置中手动调整或点击 AI 生成；保存配置不会调用模型。');
    } catch (error) { setStatus(error instanceof Error ? error.message : '配置保存失败。'); }
    finally { setSaving(false); }
  }
  return <section className="ai-settings"><h3><Bot size={16} />AI 翻译配置</h3><div className="config-fields"><label>服务地址<input value={draft.url} onChange={(event) => change('url', event.target.value)} placeholder="https://api.deepseek.com" spellCheck={false} aria-label="AI 服务地址" /></label><label>模型名称<input value={draft.model} onChange={(event) => change('model', event.target.value)} placeholder="deepseek-flash" spellCheck={false} aria-label="AI 模型名称" /></label><label className="key-field">API Key<div><input type={showKey ? 'text' : 'password'} value={draft.key} onChange={(event) => change('key', event.target.value)} autoComplete="off" spellCheck={false} aria-label="翻译 API Key" placeholder="在本机填写你的密钥" /><button aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label></div>
    <p className="field-help">系统自动安排翻译与复核。每次明确歌名、歌手和上下文，核对行号与原文后才保存；不需要设置预算、句数或输出上限。</p><p className="field-help">相同歌曲的重复句去重并复用已核对缓存，不上传音频。AI 复核不是人工审校，译文可在核对表中修改；已提交的请求仍可能计费。</p>
    <div className="audio-alignment-settings"><h4>逐字歌词生成配置</h4><p className="field-help">在歌词设置中调整每字起止时间，或主动点击 AI 生成。启动、切歌和保存配置均不会自动生成。</p>
      <label className="audio-model-field">生成方式<select aria-label="逐字时间生成方式" value={draft.alignmentMode ?? 'text'} onChange={(event) => change('alignmentMode', event.target.value === 'audio' ? 'audio' : 'text')}><option value="text">聊天 AI 估算（默认，使用现有模型）</option><option value="audio">音频模型识别（需字词时间戳接口）</option></select></label>
      {draft.alignmentMode === 'audio' ? <><label className="audio-model-field">音频识别模型<input aria-label="音频识别模型" value={draft.audioModel ?? 'whisper-1'} onChange={(event) => change('audioModel', event.target.value)} placeholder="whisper-1" spellCheck={false} /></label><p className="field-help">复用上方服务地址和密钥，需支持 audio/transcriptions、verbose_json 和 word 时间戳。此方式上传当前音频，可能产生音频费用；DeepSeek 官方聊天接口不支持此方式。</p></> : <><label className="audio-model-field">唱法提示（可选）<textarea aria-label="唱法提示" maxLength={1200} rows={2} value={draft.singingHint ?? ''} onChange={(event) => change('singingHint', event.target.value)} placeholder="例如：逗号处换气，副歌连唱，句尾拖音；留空由 AI 分析" /></label><p className="field-help">直接使用上方聊天模型（包括 DeepSeek），先分析唱法、停顿、重音与拖音，再在原句开始和结束时间内估算各字词。只发送歌词、歌曲信息和唱法提示，不上传音频，可能消耗文本 token。没有听取录音，不能保证精确同步；结果明确标注“AI 估算时间”。</p></>}
      <p className="field-help">普通歌词继续按整句匀速高亮。手动保存或主动生成并保存后，逐字时间写入增强 LRC 和曲库；原音频和已有中文保留。整首 AI 生成会跳过已有逐字时间；生成本句可重新估算选中的句子。</p>
    </div>
    {canRememberKey() && <label className="remember-key"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />在这台设备上加密保存密钥（推荐）</label>}
    {keyPath && <p className="field-help">加密配置文件：<code>{keyPath}</code><br />Windows 使用当前账户系统加密；安卓使用 Android Keystore，解密用的系统密钥不写入此文件、不随音乐包导出。换设备或卸载后可能需要重新填写。</p>}
    <div className="config-save"><button className="button outline" disabled={saving} onClick={() => void save()}><Check size={14} />保存 AI 配置</button><span role="status">{status || (canRememberKey() ? '默认加密保存，重启自动读取；取消勾选并保存会清除已存密钥。' : '浏览器预览不支持系统加密，密钥仅在本次运行中使用。')}</span></div>
  </section>;
}
