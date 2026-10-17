import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Clock3, LoaderCircle, Pause, Play, Save, X } from 'lucide-react';
import type { AIConfig, LyricLine, Track } from '../types';
import { generateTextAlignment } from '../lib/textAlignment';
import { generateWordAlignment } from '../lib/audioAI';
import { needsWordAlignment, vocalLine } from '../lib/audioAlignment';
import { timedWords } from '../lib/lyricTiming';
import { sourceLibraryScope } from '../lib/storage';
import { applyLineTimeDraft, changeSingingEnd, createLineTimeDraft, lineTimeEnd, timingFingerprint, type LineTimeDraft } from '../lib/lyricTimingEditor';
import TimedLyricText from './TimedLyricText';

type Props = { tracks: Track[]; currentId: string; position: number; playing: boolean; config: AIConfig; blocked: boolean; onBusy(value: boolean): void; onSeek(time: number): void; onTogglePlay(): void; onPlayTrack(id: string): void; onSave(id: string, expected: string, lyrics: LyricLine[]): Promise<void>; onClose(): void };
export default function LyricTimingDialog(props: Props) {
  const [trackId, setTrackId] = useState(() => props.tracks.find((track) => track.id === props.currentId)?.id || props.tracks[0]?.id || '');
  const selected = props.tracks.find((track) => track.id === trackId);
  return <div className="modal-backdrop"><section className="modal lyric-timing-dialog" role="dialog" aria-modal="true" aria-label="歌词设置"><div className="modal-heading"><div><span className="eyebrow">LYRIC TIMING</span><h2>歌词设置</h2></div><button className="icon-button" aria-label="关闭歌词设置" onClick={props.onClose}><X size={20} /></button></div>
    {selected ? <SongTimingEditor key={selected.id} {...props} track={selected} trackId={trackId} onSelect={setTrackId} /> : <p>导入本地歌曲和歌词后，即可调整逐字时间。</p>}
  </section></div>;
}

function SongTimingEditor(props: Props & { track: Track; trackId: string; onSelect(id: string): void }) {
  const { track, config } = props;
  const [lyrics, setLyrics] = useState(() => structuredClone(track.lyrics));
  const [baseline, setBaseline] = useState(() => timingFingerprint(track.lyrics));
  const [lineIndex, setLineIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, LineTimeDraft>>({});
  const [aiDirty, setAIDirty] = useState(false);
  const [hint, setHint] = useState(config.singingHint || '');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const scope = useRef<Promise<string> | null>(null);
  const alive = useRef(true);
  const latest = useRef(props); latest.current = props;
  useEffect(() => { alive.current = true; scope.current = sourceLibraryScope().catch(() => ''); return () => { alive.current = false; controller.current?.abort(); latest.current.onBusy(false); }; }, []);
  const working = useMemo(() => ({ ...track, lyrics }), [track, lyrics]);
  const draft = useMemo(() => drafts[lineIndex] || createLineTimeDraft(working, lineIndex), [drafts, lineIndex, working]);
  const line = lyrics[lineIndex];
  const dirty = aiDirty || Object.keys(drafts).length > 0;
  const conflict = timingFingerprint(track.lyrics) !== baseline;
  const disabled = running || saving || props.blocked || conflict;
  const canSample = props.currentId === track.id;
  let preview: LyricLine | undefined;
  try { if (line) preview = applyLineTimeDraft(working, lineIndex, draft); } catch { /* Inputs may be incomplete while editing. */ }
  const change = (next: LineTimeDraft) => { setDrafts((previous) => ({ ...previous, [lineIndex]: next })); setMessage(''); };
  const editWord = (index: number, field: 'start' | 'end', value: string) => change({ ...draft, words: draft.words.map((word, wordIndex) => wordIndex === index ? { ...word, [field]: value } : word) });
  function collect(includeCurrent: boolean, except?: number) {
    const entries = { ...drafts, ...(includeCurrent && line ? { [lineIndex]: draft } : {}) };
    const anchors = lyrics.map((line, index) => entries[index] && index !== except ? { ...line, time: Number(entries[index].start) } : line);
    const next = anchors.map((line, index) => entries[index] && index !== except ? applyLineTimeDraft({ ...track, lyrics: anchors }, index, entries[index]) : line);
    // A changed line anchor also bounds the preceding phrase.
    for (let index = 0; index < next.length; index++) {
      const words = timedWords(next[index]); const end = lineTimeEnd({ ...track, lyrics: next }, index);
      if ((next[index].endTime ?? 0) > end || words?.some((word) => (word.endTime ?? word.time) > Math.min(end, next[index].endTime ?? end))) throw new Error(`第 ${index + 1} 句与下一句时间重叠或超过唱完时间，请调整后保存。`);
    }
    return next;
  }
  async function ensureCurrent() {
    if (latest.current.blocked || timingFingerprint(latest.current.track.lyrics) !== baseline || await scope.current !== await sourceLibraryScope()) throw new Error('歌曲歌词或音乐库已改变，请还原未保存修改后重试。');
  }
  async function save() {
    if (disabled) return;
    setSaving(true); setMessage('');
    try { await ensureCurrent(); const next = collect(true); await props.onSave(track.id, baseline, next); if (!alive.current) return; setLyrics(next); setDrafts({}); setAIDirty(false); setBaseline(timingFingerprint(next)); setMessage('逐字时间已保存，主窗口和桌面歌词已更新。'); }
    catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : '保存失败，原歌词保留。'); }
    finally { if (alive.current) setSaving(false); }
  }
  async function generate(wholeSong: boolean) {
    if (disabled || controller.current || !line) return;
    const abort = new AbortController(); controller.current = abort; setRunning(true); props.onBusy(true); setMessage('正在生成逐字时间…');
    try {
      await ensureCurrent();
      const next = collect(false, wholeSong ? undefined : lineIndex);
      const start = draft.start.trim() ? Number(draft.start) : NaN;
      const endTime = draft.end.trim() ? Number(draft.end) : NaN;
      if (!wholeSong && (!Number.isFinite(start) || start < (next.slice(0, lineIndex).filter((line) => line.time >= 0).at(-1)?.time ?? 0) || start >= lineTimeEnd({ ...track, lyrics: next }, lineIndex))) throw new Error('请先设置有效的本句开始时间，再生成逐字时间。');
      if (!wholeSong && (!Number.isFinite(endTime) || endTime <= start || endTime > lineTimeEnd({ ...track, lyrics: next }, lineIndex))) throw new Error('请先设置有效的本句唱完时间，间奏不计入演唱时间。');
      const input = { ...track, lyrics: next.map((line, index) => !wholeSong && index === lineIndex ? { ...line, time: start, endTime, words: undefined, wordTiming: undefined, timingNote: undefined } : line) };
      if (wholeSong ? !needsWordAlignment(input) : !vocalLine(input.lyrics[lineIndex])) { setMessage('当前范围已有逐字时间或没有演唱文本，已跳过，未调用 AI。'); return; }
      const options = { stage: (message: string) => { if (alive.current) setMessage(message); } };
      const result = config.alignmentMode === 'audio' ? await generateWordAlignment(input, config, abort.signal, options) : await generateTextAlignment(input, { ...config, singingHint: hint }, abort.signal, { ...options, lineIds: wholeSong ? undefined : [lineIndex] });
      abort.signal.throwIfAborted(); await ensureCurrent();
      if (!alive.current) return;
      const generated = wholeSong ? result.lyrics : next.map((line, index) => index === lineIndex ? result.lyrics[index] : line);
      if (!result.matched || (!wholeSong && !timedWords(generated[lineIndex]))) { setMessage('当前范围没有可生成的句子：已有逐字时间会跳过，未定时歌词需先设置本句开始时间。'); return; }
      setLyrics(generated); setDrafts({}); setAIDirty(true); setMessage('AI 生成完成，可继续调整；点击“保存歌词时间”后生效。');
    } catch (error) { if (alive.current) setMessage(abort.signal.aborted ? '生成已取消，未保存的调整保留。' : error instanceof Error ? error.message : '生成失败，原歌词保留。'); }
    finally { if (controller.current === abort) controller.current = null; if (alive.current) { setRunning(false); props.onBusy(false); } }
  }
  function restore() { setLyrics(structuredClone(track.lyrics)); setBaseline(timingFingerprint(track.lyrics)); setDrafts({}); setAIDirty(false); scope.current = sourceLibraryScope().catch(() => ''); setMessage('已还原为当前保存的歌词。'); }
  return <>
    <p className="field-help">手动调整每个字词的开始和结束时间，保存后生效。AI 仅在点击生成按钮后调用。</p>
    <label className="timing-song-select">歌曲<select aria-label="歌词歌曲" value={props.trackId} disabled={running || saving} onChange={(event) => { if (dirty) { setMessage('请先保存歌词时间或还原未保存修改，再切换歌曲。'); return; } props.onSelect(event.target.value); }}>{props.tracks.map((track) => <option key={track.id} value={track.id}>{track.title} · {track.artist}</option>)}</select></label>
    {!lyrics.length ? <p>这首歌尚无歌词，请先单独导入歌词或联网补全。</p> : <>
      <label className="timing-song-select">句子<select aria-label="歌词句子" value={lineIndex} disabled={running || saving} onChange={(event) => setLineIndex(Number(event.target.value))}>{lyrics.map((line, index) => <option key={index} value={index}>{index + 1}. {line.text || '（空行）'}</option>)}</select></label>
      {line && <>
        <div className="timing-line-clock"><label>本句开始（秒）<input aria-label="本句开始时间" type="number" min="0" step="0.001" disabled={disabled} value={draft.start} onChange={(event) => change({ ...draft, start: event.target.value })} /></label><label>本句唱完（秒）<input aria-label="本句唱完时间" type="number" min="0" step="0.001" disabled={disabled} value={draft.end} onChange={(event) => change(changeSingingEnd(draft, event.target.value))} /></label><button className="button outline" disabled={disabled || !canSample} onClick={() => change(changeSingingEnd(draft, props.position.toFixed(3)))}>取当前为唱完</button><span>{lineIndex < lyrics.length - 1 ? '下一句开始' : '歌曲结尾'}：{lineTimeEnd(working, lineIndex).toFixed(3)} 秒</span></div>
        <p className="field-help">唱完到下一句之间可留间奏。缩短唱完时间时，超出范围的逐字草稿会按比例收紧；也可逐字微调。</p>
        {Number(draft.end) < lineTimeEnd(working, lineIndex) && <p className="field-help">本句唱完后预留 {(lineTimeEnd(working, lineIndex) - Number(draft.end)).toFixed(3)} 秒间奏或停顿，期间高亮停在唱完的位置。</p>}
        {line.wordTiming === 'estimated' && line.timingNote && <p className="field-help">AI 估算：{line.timingNote}</p>}
        <div className="timing-preview"><TimedLyricText text={line.text} words={preview?.words} active={canSample} position={props.position} lineStart={preview?.time ?? line.time} lineEnd={preview?.endTime ?? Number(draft.end)} /></div>
        <div className="timing-playback"><span>{canSample ? `当前播放时间：${props.position.toFixed(3)} 秒` : '播放这首歌后，可边听边取当前时间。'}</span><button className="button outline" onClick={() => canSample ? props.onTogglePlay() : props.onPlayTrack(track.id)}>{canSample && props.playing ? <Pause size={14} /> : <Play size={14} />}{canSample ? props.playing ? '暂停当前歌曲' : '播放当前歌曲' : '播放所选歌曲'}</button></div>
        {!timedWords(line) && <p className="field-help">当前显示按原句时间均分的可编辑草稿；保存前仍沿用原歌词。</p>}
        <div className="word-time-list"><div className="word-time-heading"><span>字 / 词</span><span>开始（秒）</span><span>结束（秒）</span><span>校准</span></div>{draft.words.map((word, index) => <div className="word-time-row" key={index} data-word-index={index}><strong>{word.text}</strong><input aria-label={`第${index + 1}字开始时间`} type="number" min="0" step="0.001" disabled={disabled} value={word.start} onChange={(event) => editWord(index, 'start', event.target.value)} /><input aria-label={`第${index + 1}字结束时间`} type="number" min="0" step="0.001" disabled={disabled} value={word.end} onChange={(event) => editWord(index, 'end', event.target.value)} /><div><button title="用当前播放时间作为开始" aria-label={`第${index + 1}字取当前开始时间`} disabled={disabled || !canSample} onClick={() => editWord(index, 'start', props.position.toFixed(3))}><Clock3 size={13} />起</button><button title="用当前播放时间作为结束" aria-label={`第${index + 1}字取当前结束时间`} disabled={disabled || !canSample} onClick={() => editWord(index, 'end', props.position.toFixed(3))}><Clock3 size={13} />止</button><button title="跳到这个字的开始" aria-label={`定位第${index + 1}字`} disabled={!canSample || !Number.isFinite(Number(word.start))} onClick={() => props.onSeek(Number(word.start))}><Play size={13} /></button></div></div>)}</div>
        <div className="timing-ai-panel"><h3><Bot size={16} />AI 生成（手动）</h3><p className="field-help">使用已配置的 {config.alignmentMode === 'audio' ? config.audioModel || 'whisper-1' : config.model}。{config.alignmentMode === 'audio' ? '识别时会上传当前歌曲音频。' : '仅发送歌词和唱法提示，结果标注 AI 估算时间。'}点击生成可能计费。</p>{config.alignmentMode !== 'audio' && <label>唱法提示<textarea aria-label="歌词唱法提示" rows={2} maxLength={1200} disabled={running || saving} value={hint} onChange={(event) => setHint(event.target.value)} placeholder="例如：逗号换气，末字拖音" /></label>}<div className="timing-actions"><button className="button outline" disabled={disabled || !config.key} onClick={() => void generate(false)}><Bot size={14} />AI 生成本句</button><button className="button outline" disabled={disabled || !config.key} onClick={() => void generate(true)}>AI 生成整首缺失时间</button>{running && <button className="button outline" onClick={() => controller.current?.abort()}><LoaderCircle className="spin" size={14} />取消生成</button>}</div>{!config.key && <p className="field-help">请先在偏好设置中保存 AI 服务、模型和密钥。</p>}</div>
      </>}
    </>}
    {conflict && <p className="timing-error" role="alert">歌词已在别处更新，请还原未保存修改后继续，避免覆盖新歌词。</p>}
    {message && <p className="timing-status" role="status">{message}</p>}
    <div className="timing-actions timing-save"><button className="button" disabled={disabled || !line || !draft.words.length} onClick={() => void save()}><Save size={15} />{saving ? '保存中…' : '保存歌词时间'}</button><button className="button outline" disabled={running || saving} onClick={restore}>还原未保存修改</button><button className="button outline" title="关闭窗口，未保存的草稿将放弃" onClick={props.onClose}>关闭</button></div>
  </>;
}
