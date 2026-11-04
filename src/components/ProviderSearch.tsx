import { useEffect, useRef, useState } from 'react';
import '../providerStyles.css';
import { Captions, Download, LoaderCircle, LogIn, Music2, Play, RefreshCw, Search, ShieldCheck, Square } from 'lucide-react';
import { beginProviderLogin, checkProviderLogin, findProviderLyrics, ProviderLoginError, providerLabel, providerRequest, providerSession, providersAvailable, resolveProviderMedia, searchProvider, type MusicProvider, type ProviderLogin, type ProviderSearchResult, type ProviderSession } from '../lib/providerSearch';
import { downloadProviderAudio, type ProviderSaveTarget } from '../lib/providerDownload';
import type { LyricLine } from '../types';
import { sourceLibraryScope } from '../lib/storage';
import { loadSourceConfig } from '../lib/onlineSource';
import { beginBackgroundTask } from '../lib/backgroundTasks';

const errorText = (error: unknown) => error instanceof Error ? error.message : '音乐平台暂不可用，请稍后重试。';
export default function ProviderSearch({ active, onDownloaded, onPlay }: {
  active: boolean;
  onDownloaded(blob: Blob, song: ProviderSearchResult, target: ProviderSaveTarget, signal: AbortSignal, lyrics: LyricLine[]): Promise<void>;
  onPlay(song: ProviderSearchResult, lyrics: LyricLine[]): Promise<void>;
}) {
  const [provider, setProvider] = useState<MusicProvider>('qq');
  const [session, setSession] = useState<ProviderSession>();
  const [login, setLogin] = useState<ProviderLogin>();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState<ProviderSearchResult[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [destination, setDestination] = useState<'local' | 'server'>('local');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [lyricsPreview, setLyricsPreview] = useState<{ id: string; lines: LyricLine[] }>();
  const lyricsCache = useRef(new Map<string, LyricLine[]>());
  const controller = useRef<AbortController | undefined>(undefined);
  const locked = useRef(false);
  const generation = useRef(0);
  const [opened, setOpened] = useState(active);
  const available = providersAvailable();
  useEffect(() => { if (active) setOpened(true); }, [active]);
  useEffect(() => {
    const revision = ++generation.current, abort = new AbortController();
    setSession(undefined); setLogin(undefined); setResults([]); setPage(0); setMore(false); setSubmitted(''); setStatus(''); setLyricsPreview(undefined);
    if (available && opened) void providerSession(provider, abort.signal).then((value) => { if (revision === generation.current) setSession(value); }).catch((error) => { if (!abort.signal.aborted && revision === generation.current) setStatus(errorText(error)); });
    return () => { abort.abort(); };
  }, [provider, available, opened]);
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    if (!login || !['waiting', 'confirmed'].includes(login.status)) return;
    const abort = new AbortController(), revision = generation.current; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await checkProviderLogin(provider, login, abort.signal);
        if (abort.signal.aborted || revision !== generation.current) return;
        if (next.status === 'logged-in') {
          const account = await providerSession(provider, abort.signal);
          if (abort.signal.aborted || revision !== generation.current) return;
          if (!account.loggedIn) throw Error('扫码已确认，但平台未验证账号状态，请刷新二维码重试。');
          setSession(account); setLogin(next); setStatus('已登录，搜索与播放将使用当前账号权限。'); return;
        }
        if (next.status === 'expired') { setLogin(next); setStatus('登录二维码已过期，请重新生成。'); return; }
        if (next.status === 'confirmed') { setLogin((previous) => previous && previous.status !== 'confirmed' ? { ...previous, status: 'confirmed' } : previous); setStatus('已检测到扫码，请在官方应用中确认登录，正在等待账号授权。'); }
      } catch (error) { if (abort.signal.aborted) return; setStatus(errorText(error)); if (error instanceof ProviderLoginError) { setLogin((previous) => previous && { ...previous, status: 'failed' }); return; } }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 800);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [provider, login?.key, login?.status]);

  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(label); const abort = new AbortController(); controller.current = abort;
    try { await action(abort.signal); }
    catch (error) { setStatus(abort.signal.aborted ? '操作已停止；未完成的下载不会加入音乐库。' : errorText(error)); }
    finally { if (controller.current === abort) controller.current = undefined; locked.current = false; setBusy(''); }
  }
  async function search(nextPage: number) {
    const keyword = nextPage === 1 ? query.trim() : submitted;
    await run('search', async (signal) => {
      setStatus('正在搜索…');
      const response = await searchProvider(provider, keyword, nextPage, signal);
      setResults((previous) => nextPage === 1 ? response.results : [...previous, ...response.results.filter((item) => !previous.some((old) => old.id === item.id))]);
      setPage(nextPage); setMore(response.more); setSubmitted(keyword);
      setStatus(response.results.length ? '结果按平台展示；实际可播放和可下载范围取决于歌曲及账号权限。' : '没有找到歌曲，换个关键词试试。');
    });
  }
  async function getLyrics(song: ProviderSearchResult, signal?: AbortSignal) {
    const key = `${song.provider}:${song.id}`;
    const cached = lyricsCache.current.get(key);
    if (cached) return cached;
    const candidates = await findProviderLyrics(song, signal);
    const lines = candidates[0]?.lyrics || [];
    lyricsCache.current.set(key, lines);
    return lines;
  }
  async function showLyrics(song: ProviderSearchResult) {
    if (lyricsPreview?.id === song.id) { setLyricsPreview(undefined); return; }
    await run(`lyrics:${song.id}`, async (signal) => {
      setStatus(`正在查找《${song.title}》的歌词…`);
      const lines = await getLyrics(song, signal);
      setLyricsPreview({ id: song.id, lines });
      setStatus(lines.length ? `已找到 ${lines.length} 行歌词；匹配来源 LRCLIB。` : '暂未找到匹配歌词，可尝试更正歌名或歌手后重搜。');
    });
  }
  async function download(song: ProviderSearchResult) {
    await run(`download:${song.id}`, async (signal) => {
      const scope = await sourceLibraryScope();
      const source = destination === 'server' ? { ...await loadSourceConfig() } : undefined;
      if (source && !source.token) throw Error('请先在偏好设置中连接可写的个人服务器。');
      const target: ProviderSaveTarget = { destination, scope, source };
      const abort = controller.current!; let job: Awaited<ReturnType<typeof beginBackgroundTask>> | undefined; let complete = false;
      try {
        job = await beginBackgroundTask({ id: `provider:${provider}:${song.id}`, title: `下载 · ${song.title}`, view: 'providers', controller: abort });
        let lyrics: LyricLine[] = [];
        try { lyrics = await getLyrics(song, signal); } catch { signal.throwIfAborted(); }
        setStatus('正在核对平台下载权限…');
        const media = await resolveProviderMedia(song, true, signal);
        const blob = await downloadProviderAudio(song, media.url, signal, (bytes) => { const message = `下载 ${song.title} · ${(bytes / 1024 / 1024).toFixed(1)} MB`; setStatus(message); job?.progress(message); });
        setStatus('正在校验完整音频并保存…'); job.progress('校验时长、音频格式与 SHA-256，随后入库');
        await onDownloaded(blob, song, target, signal, lyrics); complete = true;
        setStatus(target.destination === 'local' ? '已保存到本地，现在可在我的音乐中查看。' : '已保存到个人服务器，正在刷新我的音乐。');
      } finally { await job?.finish(complete ? 'completed' : signal.aborted ? 'paused' : 'failed', complete ? '完整音频已校验并保存。' : '未完成入库；请在在线搜索中重新下载。'); }
    });
  }
  return <section className="provider-search-page">
    <header className="provider-heading"><span className="eyebrow">EXPLORE YOUR MUSIC</span><h1>在线搜索<span className="heading-dot">.</span></h1><p>听过的歌会出现在最近播放。完整保存到本地或个人服务器后，才加入我的音乐。</p></header>
    <div className="provider-toolbar"><div className="provider-tabs" role="group" aria-label="选择在线音乐平台">{(['qq', 'netease'] as const).map((item) => <button key={item} disabled={!!busy} aria-pressed={provider === item} onClick={() => setProvider(item)}>{providerLabel(item)}</button>)}</div>
      <div className="provider-account"><span>{session?.loggedIn ? session.accountName || '已登录' : '未登录'}</span>{session?.loggedIn ? <button className="text-button" disabled={!!busy} onClick={() => void run('logout', async () => { generation.current++; setLogin(undefined); await providerRequest(provider, 'logout'); setSession({ loggedIn: false }); setStatus('已清除本设备的账号会话。'); })}>退出登录</button> : <button className="button outline" disabled={!available || !!busy} onClick={() => void run('login', async (signal) => { setLogin(undefined); setStatus('正在创建官方扫码会话…'); const value = await beginProviderLogin(provider, signal); setLogin(value); setStatus(`请使用${providerLabel(provider)}官方应用扫码，并在手机上确认。`); })}><LogIn size={15} />扫码登录</button>}</div>
    </div>
    {login && ['waiting', 'confirmed', 'expired'].includes(login.status) && <div className="provider-login-code"><img src={login.qrImageUrl} alt={`${providerLabel(provider)}登录二维码`} className={login.status === 'expired' ? 'expired' : ''} /><div><strong>{login.status === 'expired' ? '二维码已过期' : login.status === 'confirmed' ? '请在手机确认登录' : `使用${providerLabel(provider)}扫码`}</strong><span>账号仅保存在当前设备，其他设备需单独登录。</span><button className="text-button" disabled={!!busy} onClick={() => void run('login', async (signal) => { setLogin(undefined); setLogin(await beginProviderLogin(provider, signal)); })}><RefreshCw size={14} />刷新二维码</button><button className="text-button" onClick={() => setLogin(undefined)}>关闭</button></div></div>}
    {!session?.loggedIn && available && <button className="text-button" disabled={!!busy} onClick={() => void run('logout', async () => { generation.current++; setLogin(undefined); await providerRequest(provider, 'logout'); setSession({ loggedIn: false }); setStatus('已清除本设备会话，可以重新扫码登录。'); })}>清除本机登录状态</button>}
    <form className="provider-search-form" onSubmit={(event) => { event.preventDefault(); void search(1); }}><label htmlFor="provider-query"><Search size={18} /><input id="provider-query" aria-label="搜索在线音乐" value={query} disabled={!!busy} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder={`搜索${providerLabel(provider)}的歌名、歌手或专辑`} /></label><button className="button primary" disabled={!available || !!busy || !query.trim()} type="submit">{busy === 'search' ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}搜索</button></form>
    <div className="provider-download-target"><span>下载到</span><div className="provider-tabs" role="group" aria-label="下载保存位置"><button disabled={!!busy} aria-pressed={destination === 'local'} onClick={() => setDestination('local')}>本地音乐库</button><button disabled={!!busy} aria-pressed={destination === 'server'} onClick={() => setDestination('server')}>个人服务器</button></div></div>
    <p className="provider-status" role="status">{!available ? '请在 Windows 或安卓安装版中使用在线音源。' : status || '可以直接搜索；登录后按你的账号权限播放与下载。'}{busy && !busy.startsWith('play:') && <button className="text-button" onClick={() => controller.current?.abort()}><Square size={12} />停止</button>}</p>
    <div className="provider-results">{results.length > 0 && <div className="provider-results-heading"><strong>“{submitted}”</strong><span>{results.length} 首 · {providerLabel(provider)}</span></div>}
      {results.map((song) => <div className="provider-result-wrap" key={song.id}><article className="provider-result"><div className="provider-result-cover">{song.coverUrl ? <img src={song.coverUrl} alt="" loading="lazy" /> : <Music2 size={23} />}</div><div className="provider-result-info"><strong>{song.title}</strong><span>{song.artist} · {song.album || '未知专辑'}</span><small>{providerLabel(song.provider)} · {Math.floor(song.duration / 60)}:{Math.floor(song.duration % 60).toString().padStart(2, '0')}</small></div><div className="provider-result-actions"><button className="icon-button" disabled={!!busy} aria-label={`查看歌词 ${song.title}`} title="查看歌词" onClick={() => void showLyrics(song)}>{busy === `lyrics:${song.id}` ? <LoaderCircle className="spin" size={18} /> : <Captions size={18} />}</button><button className="icon-button" disabled={!!busy || !song.capabilities.playback} aria-label={`在线播放 ${song.title}`} onClick={() => void run(`play:${song.id}`, async (signal) => { setStatus('正在获取歌词并解析播放地址…'); let lyrics: LyricLine[] = []; try { lyrics = await getLyrics(song, signal); } catch { signal.throwIfAborted(); } await onPlay(song, lyrics); setStatus(lyrics.length ? '已开始播放，歌词显示在播放器歌词面板。' : '已开始播放；暂未找到匹配歌词。'); })}>{busy === `play:${song.id}` ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}</button><button className="icon-button" disabled={!!busy} aria-label={`下载 ${song.title}`} title="下载 MP3" onClick={() => void download(song)}>{busy === `download:${song.id}` ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}</button></div></article>{lyricsPreview?.id === song.id && <div className="provider-lyrics-preview">{lyricsPreview.lines.length ? lyricsPreview.lines.slice(0, 8).map((line, index) => <p key={`${line.time}-${index}`}>{line.text}</p>) : <p>暂未找到匹配歌词。</p>}</div>}</div>)}
      {!results.length && <div className="provider-empty"><Music2 size={30} /><strong>发现下一首喜欢的歌</strong><span>选择平台，输入歌名或歌手开始搜索。</span></div>}
      {more && <button className="button outline provider-more" disabled={!!busy} onClick={() => void search(page + 1)}>更多结果</button>}
    </div>
    <p className="provider-privacy"><ShieldCheck size={15} />账号会话在本设备加密保存。试听片段、下载失败和未完成校验的文件不会加入曲库。</p>
  </section>;
}
