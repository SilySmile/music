import { useRef, useState } from 'react';
import type { ForcedAlignConfig } from '../types';
import { checkForcedAlignment, forcedUrl, readForcedConfig } from '../lib/forcedAlignment';

export default function ForcedAlignmentSettings({ value, onChange, status, onRetry }: { value?: ForcedAlignConfig; onChange(value: ForcedAlignConfig): void; status?: string; onRetry?(): void }) {
  const config = readForcedConfig(value);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const change = (patch: Partial<ForcedAlignConfig>) => onChange({ ...config, ...patch });
  async function check() {
    setChecking(true);
    try { const result = await checkForcedAlignment(config); setMessage(result.ready ? result.resource_ready ? `连接成功：${result.model}，服务最多 ${result.concurrency} 首并发。` : `连接成功，暂缓处理：${result.reason}` : `模型未就绪：${result.reason || '请等待启动完成'}`); }
    catch (error) { setMessage(error instanceof Error ? error.message : '连接失败，请启动本地模型。'); }
    finally { setChecking(false); }
  }
  return <div className="forced-alignment-settings"><p className="field-help">上传音频和现有原歌词，由本地模型测量逐字时间。此处服务和密钥独立于翻译配置。</p>
    <label className="audio-model-field">强对齐服务地址<input aria-label="强对齐服务地址" value={config.url} onChange={(event) => change({ url: event.target.value })} placeholder="http://127.0.0.1:8765/v1" /></label>
    <label className="audio-model-field">强对齐模型名称<input aria-label="强对齐模型名称" value={config.model} onChange={(event) => change({ model: event.target.value })} /></label>
    <label className="audio-model-field">本地服务密钥<input aria-label="强对齐服务密钥" type="password" autoComplete="off" value={config.key} onChange={(event) => change({ key: event.target.value })} /></label>
    <p className="field-help">首次运行 local-aligner 中的准备脚本会生成“播放器连接配置.json”，其中包含这三项；可以直接导入。模型文件夹名称不是服务地址，密钥由本机随机生成，无需向第三方申请。</p>
    <input ref={input} type="file" accept=".json" aria-label="本地强对齐连接配置文件" style={{ display: 'none' }} onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      try {
        if (file.size > 16000) throw new Error('连接配置文件过大。');
        const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
        if (data.format !== 'xianqiji-local-aligner' || typeof data.url !== 'string' || typeof data.model !== 'string' || !data.model.trim() || typeof data.key !== 'string' || !data.key.trim() || data.key.length > 1000 || /[\r\n]/.test(data.key)) throw new Error('连接配置格式无效。');
        forcedUrl(data.url); onChange(readForcedConfig({ ...data, automatic: false })); setMessage('连接配置已导入，请测试连接，再保存 AI 配置；自动处理默认关闭。');
      } catch (error) { setMessage(error instanceof Error ? error.message : '连接配置读取失败。'); }
    }} />
    <div className="timing-actions"><button className="button outline" onClick={() => input.current?.click()}>导入本地强对齐配置</button><button className="button outline" disabled={checking || !config.key} onClick={() => void check()}>{checking ? '正在连接…' : '测试强对齐连接'}</button></div>
    <label className="remember-key"><input type="checkbox" aria-label="自动本地强对齐" checked={config.automatic} disabled={!window.tingyuDesktop} onChange={(event) => change({ automatic: event.target.checked })} />自动处理本地歌曲（桌面端）</label>
    <label className="audio-model-field">最大并发歌曲数<select aria-label="强对齐最大并发数" value={config.concurrency} onChange={(event) => change({ concurrency: Number(event.target.value) === 1 ? 1 : 2 })}><option value={1}>1 · 更轻量</option><option value={2}>2 · 平衡（推荐）</option></select></label>
    <p className="field-help">手动模式在歌词设置中生成并试听后保存。自动模式开启并保存后，只补齐缺失时间和旧的聊天 AI 估算结果；已有有效实测逐字时间跳过。自动结果直接保存，原文与中文保留；服务停止或资源紧张时等待，失败项不会连续重试。模型仅由你的一键脚本启动。</p>
    {message && <p className="field-help" role="status">{message}</p>}{status && <p className="field-help" role="status">{status}</p>}{config.automatic && onRetry && <button className="button outline" onClick={onRetry}>重试本地强对齐失败项</button>}
  </div>;
}
