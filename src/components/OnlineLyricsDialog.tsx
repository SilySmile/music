import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Download, Globe2, Languages, LoaderCircle, Search, Settings2, X } from 'lucide-react';
import type { AIConfig, LyricLine, Track } from '../types';
import { findLyrics, languages, needsTranslation, translateMissingLyrics, type LyricCandidate } from '../lib/onlineLyrics';
import { translateWithAI, uniqueMissingLines } from '../lib/aiTranslation';
import { cacheTranslation, getCachedTranslation } from '../lib/storage';
import { beginBackgroundTask, type BackgroundHandle } from '../lib/backgroundTasks';

type LyricPatch = Pick<Track, 'lyrics' | 'lyricsSource' | 'translationSource' | 'onlineUpdatedAt' | 'translationAudit'>;

export default function OnlineLyricsDialog({ track, aiConfig, onSave, onClose, onConfigure, onBusy, blocked = false }: { track: Track; aiConfig: AIConfig; onSave(patch: LyricPatch): Promise<void>; onClose(): void; onConfigure(): void; onBusy(value: boolean): void; blocked?: boolean }) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist === '未知艺术家' ? '' : track.artist);
  const [results, setResults] = useState<LyricCandidate[]>([]);
  const [selected, setSelected] = useState<LyricCandidate | null>(null);
  const [provider, setProvider] = useState<'ai' | 'free'>('ai');
  const [retranslate, setRetranslate] = useState(false);
  const [language, setLanguage] = useState('autodetect');
  const [working, setWorking] = useState<'search' | 'translate' | 'save' | null>(null);
  const [status, setStatus] = useState('');
  const [usage, setUsage] = useState('');
  const [stage, setStage] = useState('');
  const [audit, setAudit] = useState(track.translationAudit);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const controllerRef = useRef<AbortController | null>(null);
  const operationLock = useRef(false);
  const draftRef = useRef({ lyrics: track.lyrics, lyricsSource: track.lyricsSource, translationSource: track.translationSource });
  const [draft, setDraft] = useState(draftRef.current);
  const mountedRef = useRef(true);
  useEffect(() => { onBusy(!!working); }, [working, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);

  const replaceDraft = (next: typeof draft) => { draftRef.current = next; setDraft(next); };

  async function searchOnline() {
    if (operationLock.current || blocked) return;
    operationLock.current = true;
    controllerRef.current = new AbortController();
    setWorking('search'); setStatus('正在查询 LRCLIB…'); setSelected(null); setResults([]);
    let job: BackgroundHandle | undefined;
    let failed = false;
    try {
      job = await beginBackgroundTask({ id: 'lyric-search', title: `查找歌词 · ${track.title}`, view: 'online', controller: controllerRef.current });
      const candidates = await findLyrics(title, artist, track.duration, controllerRef.current.signal);
      if (!mountedRef.current) return;
      setResults(candidates);
      setStatus(candidates.length ? `找到 ${candidates.length} 个版本，请核对歌手、专辑和时长后选择。` : '未找到可用歌词。可修改歌名、去掉歌手重搜，或导入本地 LRC。纯音乐可能没有歌词。');
    } catch (error) { failed = true; if (mountedRef.current) setStatus(controllerRef.current.signal.aborted ? '查询已取消。' : `查询失败：${error instanceof Error ? error.message : '请检查网络后重试。'}`); }
    finally { await job?.finish(controllerRef.current.signal.aborted ? 'paused' : failed ? 'failed' : 'completed', '歌词查询结束，可返回窗口核对版本。'); operationLock.current = false; if (mountedRef.current) setWorking(null); }
  }

  async function translate(lines: LyricLine[], source = draftRef.current.lyricsSource) {
    if (operationLock.current || blocked) return;
    operationLock.current = true;
    controllerRef.current = new AbortController();
    setWorking('translate'); setStatus('正在准备翻译…'); setUsage('');
    let job: BackgroundHandle | undefined;
    let failed = false;
    try {
      job = await beginBackgroundTask({ id: 'lyric-translation', title: `翻译与校对 · ${track.title}`, view: 'online', controller: controllerRef.current });
      const song = { title: selected?.title || title.trim() || track.title, artist: selected?.artist || artist.trim() || track.artist, album: selected?.album || track.album };
      const options = { song, retranslate: provider === 'ai' && retranslate && !selected, signal: controllerRef.current.signal, cache: { get: getCachedTranslation, set: cacheTranslation }, onStage: (text: string) => { job?.progress(text); if (mountedRef.current) setStage(text); }, onProgress: (completed: number, total: number) => { job?.progress(`已核对 ${completed} / ${total} 句`); if (mountedRef.current) setProgress({ completed, total }); } };
      const result = await (async () => {
        if (provider !== 'ai') return translateMissingLyrics(lines, language, options);
        const translated = await translateWithAI(lines, aiConfig, language, options);
        if (mountedRef.current) setUsage(`本次 ${translated.requests} 次请求 · 缓存命中 ${translated.cacheHits} 句 · ${translated.usageReported ? `输入 ${translated.inputTokens} / 输出 ${translated.outputTokens} token` : '部分请求未返回用量，实际计费请查看服务账单'}`);
        return translated;
      })();
      const translationSource = provider === 'ai' ? `AI 机器翻译 · ${aiConfig.model}` : 'MyMemory 机器翻译';
      if (result.translatedCount) {
        const translationAudit = provider === 'ai' ? { song: song.title, artist: song.artist, model: aiConfig.model, verifiedAt: Date.now(), checkedLines: 'verifiedCount' in result ? Number(result.verifiedCount) : 0 } : undefined;
        await onSave({ lyrics: result.lyrics, lyricsSource: source, translationSource, translationAudit, onlineUpdatedAt: Date.now() });
        setAudit(translationAudit);
        if (mountedRef.current) replaceDraft({ lyrics: result.lyrics, lyricsSource: source, translationSource });
      }
      if (!mountedRef.current) return;
      setStatus(result.error || (result.cancelled ? `已取消，已保留 ${result.translatedCount} 行新译文；已提交的请求仍可能计费。` : result.translatedCount ? `已保存 ${result.translatedCount} 行中文译文${result.remaining ? `，还有 ${result.remaining} 行可继续翻译` : '，以后离线也能看'}。` : '没有需要翻译的缺失行；已有译文和中文原文会保留。'));
    } catch (error) { failed = true; if (mountedRef.current) setStatus(error instanceof Error ? error.message : '翻译失败，请稍后重试。'); }
    finally { await job?.finish(controllerRef.current.signal.aborted ? 'paused' : failed ? 'failed' : 'completed', '翻译任务已结束；已核对译文按原流程保存，请查看结果。取消或中断不会自动重新计费。'); operationLock.current = false; if (mountedRef.current) setWorking(null); }
  }

  async function useCandidate(withTranslation: boolean) {
    if (!selected || operationLock.current || blocked) return;
    operationLock.current = true; setWorking('save');
    try {
      const source = `LRCLIB #${selected.id}`;
      const lyrics = selected.lyrics.map((line) => {
        const local = draftRef.current.lyrics.find((candidate) => candidate.text === line.text && candidate.translation);
        return { ...line, translation: line.translation ?? local?.translation };
      });
      await onSave({ lyrics, lyricsSource: source, translationSource: draftRef.current.translationSource, onlineUpdatedAt: Date.now() });
      replaceDraft({ lyrics, lyricsSource: source, translationSource: draftRef.current.translationSource });
      setSelected(null); setStatus('这份歌词已保存到本机。');
      operationLock.current = false; setWorking(null);
      if (withTranslation) await translate(lyrics, source);
    } catch (error) { setStatus(error instanceof Error ? error.message : '保存失败。'); }
    finally { operationLock.current = false; if (mountedRef.current) setWorking(null); }
  }

  const translationLines = selected?.lyrics ?? draft.lyrics;
  const candidates = provider === 'ai' && retranslate && !selected ? translationLines.map((line) => ({ ...line, translation: undefined })) : translationLines;
  const missing = uniqueMissingLines(candidates);
  const characterCount = missing.reduce((total, text) => total + [...text].length, 0);
  const canTranslate = candidates.some(needsTranslation);

  async function saveReview() {
    if (operationLock.current) return;
    operationLock.current = true; setWorking('save');
    try { await onSave({ ...draft, translationAudit: audit, onlineUpdatedAt: Date.now() }); setStatus('人工核对后的译文已保存，可离线查看及导出。'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); }
    finally { operationLock.current = false; setWorking(null); }
  }

  return <div className="modal-backdrop online-backdrop"><section className="modal online-dialog" role="dialog" aria-modal="true" aria-labelledby="online-title"><div className="modal-heading"><div><span className="eyebrow">LYRICS, A LITTLE CLOSER</span><h2 id="online-title">联网补全歌词与译文</h2></div><button className="icon-button" aria-label="关闭联网歌词" title={working ? '后台继续处理' : '关闭'} onClick={onClose}><X size={20} /></button></div>
    <div className="online-search-fields"><label>歌名<input aria-label="联网歌词歌名" value={title} disabled={!!working} onChange={(event) => setTitle(event.target.value)} /></label><label>歌手<input aria-label="联网歌词歌手" value={artist} disabled={!!working} onChange={(event) => setArtist(event.target.value)} placeholder="不确定可以留空" /></label><button className="button primary" disabled={!!working || !title.trim()} onClick={() => void searchOnline()}>{working === 'search' ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}搜索歌词</button></div>
    {results.length > 0 && <div className="lyric-results" aria-label="歌词搜索结果">{results.map((candidate) => <button key={candidate.id} className={selected?.id === candidate.id ? 'candidate chosen' : 'candidate'} disabled={!!working} onClick={() => setSelected(candidate)}><span className="candidate-icon">{candidate.synced ? <MusicLabel /> : <Globe2 size={16} />}</span><span><strong>{candidate.title}</strong><small>{candidate.artist} · {candidate.album || '未知专辑'} · {Math.floor(candidate.duration / 60)}:{String(Math.round(candidate.duration % 60)).padStart(2, '0')}</small></span><em>{candidate.synced ? '同步 LRC' : '纯文本'}</em>{selected?.id === candidate.id && <Check size={15} />}</button>)}</div>}
    {selected && <section className="candidate-preview"><div><strong>歌词预览</strong><span>{selected.lyrics.length} 行 · {selected.synced ? '可同步定位' : '没有时间轴，仅供阅读'}</span></div><pre>{selected.lyrics.slice(0, 8).map((line) => line.text).join('\n')}</pre><p className="field-help">使用这份歌词会替换当前原文；相同原文的已有译文会保留。</p><div className="candidate-actions"><button className="button outline" disabled={!!working} onClick={() => void useCandidate(false)}><Download size={14} />使用这份歌词</button><button className="button primary" disabled={!!working || !canTranslate || (provider === 'ai' && !aiConfig.key)} onClick={() => void useCandidate(true)}><Languages size={14} />保存并翻译中文</button></div></section>}
    <section className="online-translation"><div className="online-translation-heading"><h3><Languages size={17} />补全中文译文</h3><button className="text-button" disabled={!!working} onClick={onConfigure}><Settings2 size={13} />配置 AI</button></div><div className="translation-options"><label>翻译方式<select aria-label="翻译方式" disabled={!!working} value={provider} onChange={(event) => setProvider(event.target.value as 'ai' | 'free')}><option value="ai">AI · {aiConfig.model}</option><option value="free">免费 MyMemory（有额度限制）</option></select></label><label>原文语言<select aria-label="歌词原文语言" disabled={!!working} value={language} onChange={(event) => setLanguage(event.target.value)}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className="translation-budget"><Bot size={19} /><div><strong>{missing.length} 个不同句子 · {characterCount} 字</strong><p>{provider === 'ai' ? '明确歌名、歌手、专辑版本及每句在全曲的位置，结合相邻歌词翻译后独立校对。默认只补缺失、重复句去重并复用已核对缓存；不设置预算或句数控件。' : '重复句只翻译一次，已有译文和中文原文保留；免费服务限额时可稍后继续。'}</p></div></div>
    {!selected && provider === 'ai' && <label className="field-help"><input type="checkbox" aria-label="重新翻译已有中文" checked={retranslate} disabled={!!working} onChange={(event) => setRetranslate(event.target.checked)} /> 重新翻译已有中文（额外计费，不用旧缓存；每批核对成功后才替换，失败保留原译文）</label>}{!selected && <button className="button primary translate-existing" disabled={!!working || !canTranslate || (provider === 'ai' && !aiConfig.key)} onClick={() => void translate(draft.lyrics)}><Languages size={15} />{provider === 'ai' && retranslate ? '重新翻译并核对' : '翻译缺失中文'}</button>}{provider === 'ai' && !aiConfig.key && <p className="field-help">请先点「配置 AI」填写你自己的服务与 API Key，保存配置本身不消耗 token。</p>}{working === 'translate' && <div className="online-progress"><progress max={progress.total || 1} value={progress.completed} /><span>{progress.completed} / {progress.total} 句</span></div>}
    </section>{!selected && draft.lyrics.length > 0 && <details className="translation-review"><summary>原文 / 中文对照核对 · {audit ? `《${audit.song}》 ${audit.artist} · AI 已核对 ${audit.checkedLines} 句` : `《${track.title}》 ${track.artist}`}</summary><p className="field-help">AI 校对不能保证零错译。可对照逐句修改，保存后同步到歌曲详情与桌面歌词。</p><div className="review-lines">{draft.lyrics.map((line, index) => <label key={index}><span>{line.text}</span><input aria-label={`第 ${index + 1} 行中文译文`} value={line.translation || ''} disabled={!!working} onChange={(event) => replaceDraft({ ...draft, lyrics: draft.lyrics.map((item, itemIndex) => itemIndex === index ? { ...item, translation: event.target.value || undefined } : item) })} placeholder="补充或修正中文译文" /></label>)}</div><button className="button outline" disabled={!!working} onClick={() => void saveReview()}>保存核对修改</button></details>}<div className="online-status" role="status">{working && <LoaderCircle size={15} className="spin" />}<span>{working === 'translate' ? `${stage || '正在准备翻译…'} ${progress.completed} / ${progress.total}` : status || (draft.lyrics.length ? `本地已有 ${draft.lyrics.length} 行歌词，可直接翻译缺失的中文。` : '先搜索并选择正确的歌曲版本，再保存或翻译。')}</span>{working && <button className="text-button" onClick={() => { controllerRef.current?.abort(); setStatus('正在取消…'); }}>取消</button>}</div>{usage && <p className="token-usage" role="status">{usage}</p>}<p className="network-disclosure">歌词来源 LRCLIB；翻译时仅发送歌曲信息与歌词文字至所选服务，不上传歌曲文件。获取后保存在本机，可离线阅读。机器译文仅供理解，未收录的歌词无法保证找到。</p>
  </section></div>;
}

function MusicLabel() { return <span className="lrc-label">LRC</span>; }
