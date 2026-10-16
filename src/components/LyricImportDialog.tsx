import { useEffect, useState } from 'react';
import { FileText, LoaderCircle, X } from 'lucide-react';
import type { Track } from '../types';
import { lyricPatches, readLyricFile, type LyricFile } from '../lib/lyricImport';

export default function LyricImportDialog({ files, tracks, onSave, onClose }: { files: File[]; tracks: Track[]; onSave(id: string, patch: Partial<Track>): Promise<void>; onClose(): void }) {
  const [entries, setEntries] = useState<LyricFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    Promise.all(files.map((file) => readLyricFile(file, tracks))).then((result) => { if (active) setEntries(result); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '歌词读取失败'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [files]);
  function change(index: number, patch: Partial<LyricFile>) { setEntries((previous) => previous.map((entry, current) => current === index ? { ...entry, ...patch } : entry)); setError(''); }
  async function save() {
    setSaving(true); setError('');
    let completed = [...saved];
    try {
      const patches = lyricPatches(entries, tracks);
      for (const item of patches) {
        if (completed.includes(item.trackId)) continue;
        await onSave(item.trackId, item.patch);
        completed = [...completed, item.trackId]; setSaved(completed);
      }
      onClose();
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : '保存失败'}${completed.length ? `（已保存 ${completed.length} 首，可重试剩余歌曲）` : ''}`); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop"><section className="modal lyric-import-modal" role="dialog" aria-modal="true" aria-labelledby="lyric-import-title">
    <div className="modal-heading"><div><span className="eyebrow">LOCAL LYRICS</span><h2 id="lyric-import-title">单独导入歌词</h2></div><button className="icon-button" aria-label="关闭歌词导入" disabled={saving} onClick={onClose}><X size={20} /></button></div>
    <p className="field-help">不重复导入音频。确认对应歌曲和文件用途后保存；同名且唯一的歌曲会自动匹配，同名多版本请手动选择。新原文保留相同文本已有的译文，新中文优先覆盖匹配行。</p>
    {!tracks.length && <p role="alert">请先导入歌曲音频，再为它添加歌词。</p>}
    {loading ? <p><LoaderCircle className="spin" size={16} />正在读取歌词…</p> : entries.map((entry, index) => <article className="lyric-import-file" key={`${index}-${entry.name}`}>
      <h3><FileText size={16} />{entry.name}</h3>
      <div className="lyric-import-fields"><label>对应歌曲<select aria-label={`对应歌曲 ${entry.name}`} disabled={saving || saved.includes(entry.trackId)} value={entry.trackId} onChange={(event) => change(index, { trackId: event.target.value })}><option value="">请选择歌曲</option>{tracks.map((track) => <option key={track.id} value={track.id}>{track.title} · {track.artist} · {track.album || '未知专辑'} · {Math.floor(track.duration)} 秒 · {track.id.slice(0, 6)}</option>)}</select></label>
      <label>文件用途<select aria-label={`文件用途 ${entry.name}`} disabled={saving || saved.includes(entry.trackId)} value={entry.role} onChange={(event) => change(index, { role: event.target.value as LyricFile['role'] })}><option value="original">原文歌词（可含双语）</option><option value="translation">中文译文</option></select></label></div>
      <p className="field-help">{entry.lines.length} 行 · {entry.lines.some((line) => line.time >= 0) ? '带时间轴，可同步滚动' : '纯文本，仅供阅读'}{saved.includes(entry.trackId) ? ' · 已保存' : ''}</p>
      <pre className="lyric-import-preview">{entry.lines.slice(0, 4).map((line) => `${line.text}${line.translation ? `\n${line.translation}` : ''}`).join('\n')}</pre>
      <button className="text-button" disabled={saving || saved.includes(entry.trackId)} onClick={() => setEntries((previous) => previous.filter((_, current) => current !== index))}>移除此文件</button>
    </article>)}
    {error && <p className="storage-error" role="alert">{error}</p>}
    <div className="confirm-actions"><button className="button outline" disabled={saving} onClick={onClose}>取消</button><button className="button primary" disabled={saving || loading || !entries.length || !tracks.length} onClick={() => void save()}>{saving && <LoaderCircle size={16} className="spin" />}保存歌词到所选歌曲</button></div>
  </section></div>;
}
