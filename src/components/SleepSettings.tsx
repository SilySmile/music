import { useState } from 'react';
import { Moon } from 'lucide-react';
import { isAndroidPlayer } from '../lib/androidPlayback';
export type SleepState = { deadline: number; behavior: 'immediate' | 'finish-track'; pending: boolean } | null;
export default function SleepSettings({ timer, now, onStart, onCancel }: { timer: SleepState; now: number; onStart(minutes: number, behavior: 'immediate' | 'finish-track'): void; onCancel(): void }) {
  const [minutes, setMinutes] = useState('30');
  const [behavior, setBehavior] = useState<'immediate' | 'finish-track'>('finish-track');
  const remaining = timer ? Math.max(0, Math.ceil((timer.deadline - now) / 1000)) : 0;
  return <section className="sleep-settings"><h3><Moon size={16} />睡眠定时</h3><div className="sleep-fields"><label>多久后停止（分钟）<input aria-label="睡眠分钟数" type="number" min="1" max="1440" value={minutes} onChange={(event) => setMinutes(event.target.value)} /></label><label>到时处理<select aria-label="睡眠停止方式" value={behavior} onChange={(event) => setBehavior(event.target.value as typeof behavior)}><option value="finish-track">播放完当时这首再停止</option><option value="immediate">到时立即停止</option></select></label></div><div className="storage-buttons"><button className="button outline" disabled={!Number.isFinite(Number(minutes)) || Number(minutes) < 1 || Number(minutes) > 1440} onClick={() => onStart(Number(minutes), behavior)}>{timer ? '重新开始定时' : '开始定时'}</button>{timer && <button className="text-button" onClick={onCancel}>取消定时</button>}</div><p className="field-help" role="status">{timer ? timer.pending ? '时间已到，当前歌曲结束后停止，不再播放下一首。' : `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒 · ${timer.behavior === 'immediate' ? '到时立即停止' : '到时播完整首停止'}` : '未开启定时；计时按实际时间，不随暂停延长。'}{isAndroidPlayer() ? '安卓后台准备完成后由原生播放服务计时；请允许播放通知并按需取消电池限制。' : '应用退出后定时自动取消。'}</p></section>;
}
