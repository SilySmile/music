import { useState } from 'react';
import { ArrowDown, ArrowUp, Disc3, Play, Plus, X } from 'lucide-react';
import type { Track } from '../types';

export default function QueueEditor({ tracks, queue, currentId, onChange, onPlay, disabled, playlist = false }: { tracks: Track[]; queue: Track[]; currentId: string; onChange(ids: string[]): void; onPlay(track: Track): void; disabled: boolean; playlist?: boolean }) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const ids = queue.map((track) => track.id);
  const move = (index: number, delta: number) => { const next = [...ids]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; onChange(next); };
  const candidates = tracks.filter((track) => !ids.includes(track.id) && `${track.title} ${track.artist}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="queue-list"><div className="queue-tools"><span>{queue.length} 首</span><button className="text-button" disabled={disabled} onClick={() => setAdding(!adding)}><Plus size={15} />添加歌曲</button><button className="text-button" disabled={disabled || !queue.length} onClick={() => onChange(!playlist && currentId && ids.includes(currentId) ? [currentId] : [])}>{playlist ? '清空歌单' : '清空待播'}</button></div>
    {adding && <div className="queue-picker"><input aria-label="搜索待添加歌曲" placeholder="搜索音乐库和最近播放" value={query} onChange={(event) => setQuery(event.target.value)} /><div>{candidates.slice(0, 100).map((track) => <button className="queue-candidate" disabled={disabled} key={track.id} onClick={() => onChange([...ids, track.id])}><span>{track.title}<small>{track.artist}</small></span><Plus size={16} /></button>)}{!candidates.length && <p>没有可添加的歌曲。</p>}{candidates.length > 100 && <p>输入歌名缩小范围。</p>}</div></div>}
    {queue.map((track, index) => <div key={track.id} className={`queue-row ${track.id === currentId ? 'active' : ''}`}><button className="queue-play" disabled={disabled} onClick={() => onPlay(track)} aria-label={`队列播放 ${track.title}`}><span>{String(index + 1).padStart(2, '0')}</span><span><strong>{track.title}</strong><small>{track.artist}</small></span>{track.id === currentId ? <Disc3 size={18} /> : <Play size={16} />}</button><div className="queue-edit-actions"><button className="icon-button" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={`上移 ${track.title}`}><ArrowUp size={16} /></button><button className="icon-button" disabled={disabled || index === queue.length - 1} onClick={() => move(index, 1)} aria-label={`下移 ${track.title}`}><ArrowDown size={16} /></button><button className="icon-button" disabled={disabled} onClick={() => onChange(ids.filter((id) => id !== track.id))} aria-label={`移出队列 ${track.title}`}><X size={16} /></button></div></div>)}
    {!queue.length && <p className="field-help">队列为空，添加歌曲开始聆听。移出队列不会删除音乐文件。</p>}
  </div>;
}
