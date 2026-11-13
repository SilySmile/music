import { useEffect, useState } from 'react';
import type { Track } from '../types';
import { sourceLibraryScope } from '../lib/storage';
import QueueEditor from './QueueEditor';
import { externalTrack, recentProvider } from '../lib/providerHistory';
import { validateProviderResult, type ProviderSearchResult } from '../lib/providerSearch';

type Playlist = { id: string; name: string; ids: string[]; songs?: ProviderSearchResult[] };
export default function PlaybackLists(props: { tracks: Track[]; queue: Track[]; currentId: string; onChange(ids: string[]): void; onPlay(track: Track): void; onPlayList(tracks: Track[], startId?: string): void; disabled: boolean }) {
  const [tab, setTab] = useState('queue');
  const [lists, setLists] = useState<Playlist[]>([]);
  const [key, setKey] = useState('');
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    void sourceLibraryScope().then((scope) => {
      if (!active) return;
      const storageKey = `xianqiji-playlists:${scope}`;
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (!Array.isArray(saved)) throw Error('歌单数据无效');
      setLists(saved.filter((item): item is Playlist => !!item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.ids) && item.ids.every((id: unknown) => typeof id === 'string')).map((list) => ({ ...list, songs: Array.isArray(list.songs) ? list.songs.flatMap((song) => { try { return [validateProviderResult(song)]; } catch { return []; } }) : [] })));
      setKey(storageKey);
    }).catch(() => { if (active) setStatus('歌单读取失败，请检查本机存储。'); });
    return () => { active = false; };
  }, []);
  function save(next: Playlist[]) {
    if (!key) return false;
    try { localStorage.setItem(key, JSON.stringify(next)); setLists(next); setStatus('歌单已保存到当前设备。'); return true; }
    catch { setStatus('歌单保存失败，请检查本机存储。'); return false; }
  }
  const current = lists.find((list) => list.id === selected);
  const available = Array.from(new Map([...(current?.songs || []).map((song) => externalTrack(recentProvider(song))), ...props.tracks].map((track) => [track.id, track])).values());
  const songs = current?.ids.map((id) => available.find((track) => track.id === id)).filter((track): track is Track => !!track) || [];
  return <><div className="provider-tabs" role="group" aria-label="播放列表类型"><button aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>当前队列</button><button aria-pressed={tab === 'lists'} onClick={() => setTab('lists')}>我的歌单</button></div>
    {tab === 'queue' ? <QueueEditor {...props} /> : <div className="playlist-manager"><div className="playlist-controls"><select aria-label="选择歌单" value={selected} onChange={(event) => { setSelected(event.target.value); setName(lists.find((list) => list.id === event.target.value)?.name || ''); }}><option value="">选择歌单</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name} · {list.ids.length} 首</option>)}</select><input aria-label="歌单名称" placeholder="输入歌单名称" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></div><div className="queue-tools"><button className="text-button" disabled={!key || !name.trim()} onClick={() => { const list = { id: crypto.randomUUID(), name: name.trim(), ids: [] }; if (save([...lists, list])) setSelected(list.id); }}>新建歌单</button><button className="text-button" disabled={!current || !name.trim()} onClick={() => save(lists.map((list) => list.id === selected ? { ...list, name: name.trim() } : list))}>重命名</button><button className="text-button" disabled={!current} onClick={() => { if (save(lists.filter((list) => list.id !== selected))) { setSelected(''); setName(''); } }}>删除歌单</button><button className="button primary" disabled={!songs.length || props.disabled} onClick={() => props.onPlayList(songs)}>播放歌单</button></div>
    {current && <><p className="field-help">歌单保存在本机，支持添加、排序和移除。删除歌单不会删除音乐文件。{current.ids.length > songs.length && `有 ${current.ids.length - songs.length} 首暂不在当前音乐库，播放时跳过。`}</p><QueueEditor playlist tracks={available} queue={songs} currentId={props.currentId} disabled={props.disabled} onChange={(ids) => save(lists.map((list) => list.id === selected ? { ...list, ids, songs: ids.flatMap((id) => { const song = available.find((track) => track.id === id)?.external?.song; return song ? [song] : []; }) } : list))} onPlay={(track) => props.onPlayList(songs, track.id)} /></>}
    {status && <p className="field-help" role="status">{status}</p>}</div>}
  </>;
}
