import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { version as appVersion } from '../package.json';
import { ArrowRight, Check, ChevronDown, Disc3, Download, FolderHeart, FolderInput, Globe2, Headphones, Heart, Info, Library, ListMusic, LoaderCircle, Lock, Maximize2, Monitor, Music2, Pause, Play, Repeat, Repeat1, Search, Settings2, Shuffle, SkipBack, SkipForward, Trash2, Unlock, Upload, Volume2, VolumeX, X } from 'lucide-react';
import type { AIConfig, DesktopState, LibraryView, Track } from './types';
import { getTracks, getTransfers, patchTrack } from './lib/storage';
import { createImportTask, filesFingerprint, runImportTask } from './lib/transfers';
import type { ImportTask } from './lib/transferTypes';
import TransferCenter from './components/TransferCenter';
import SeasonAtmosphere, { seasonLabels, type SeasonChoice } from './components/SeasonAtmosphere';
import { activeLyricIndex } from './lib/lyrics';
import { useAutomaticAlignment } from './lib/useAutomaticAlignment';
import { timedWords } from './lib/lyricTiming';
import TimedLyricText from './components/TimedLyricText';
import DesktopSettings from './components/DesktopSettings';
import CloseSettings from './components/CloseSettings';
import StorageSettings from './components/StorageSettings';
import OnlineSourceSettings from './components/OnlineSourceSettings';
import { useSourceAutoSync } from './lib/useSourceAutoSync';
import { useCloudLibrary } from './lib/useCloudLibrary';
import { mergeCloudTracks } from './lib/cloudLibrary';
import { libraryPage } from './lib/libraryPage';
import AISettings from './components/AISettings';
import OnlineLyricsDialog from './components/OnlineLyricsDialog';
import LyricImportDialog from './components/LyricImportDialog';
import ExportDialog from './components/ExportDialog';
import { defaultAIConfig } from './lib/aiTranslation';
import { loadSavedKey, persistKey } from './lib/secureConfig';
import { createAudioFader, modeLabels, nextMode, nextTrackId, type PlaybackMode } from './lib/playback';
import SleepSettings, { type SleepState } from './components/SleepSettings';
import ShortcutSettings from './components/ShortcutSettings';
import UpdateSettings from './components/UpdateSettings';
import { startupUpdateCheck } from './lib/appUpdates';
import StartupScreen from './components/StartupScreen';
import { nativeAudioUrl } from './lib/nativeAudio';
import { androidPlayer, androidQueueOptions, isAndroidPlayer, prepareAndroidQueue, type AndroidPlaybackState } from './lib/androidPlayback';

type Modal = 'import' | 'settings' | 'queue' | 'online' | 'lyrics' | 'export' | 'transfers' | null;
const viewNames: Record<LibraryView, string> = { all: '我的音乐', favorites: '我喜欢的', recent: '最近播放' };

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const nativeUrl = nativeAudioUrl(blob);
    if (nativeUrl) { setUrl(nativeUrl); return; }
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);
  return url;
}

function Artwork({ track, className = '' }: { track?: Track; className?: string }) {
  const coverUrl = useBlobUrl(track?.cover);
  const color = track ? [...track.title].reduce((total, character) => total + character.charCodeAt(0), 0) % 4 : 0;
  return <div className={`artwork color-${color} ${className}`}>
    {coverUrl ? <img loading="lazy" src={coverUrl} alt={`${track?.title} 封面`} /> : <><span className="art-orbit" /><Disc3 aria-hidden="true" /><span className="art-caption">XIANQIJI<br />SOUND ARCHIVE</span></>}
  </div>;
}

export default function App() {
  const [storedTracks, setTracks] = useState<Track[]>([]);
  const cloud = useCloudLibrary(useCallback((track: Track) => { setTracks((previous) => [...previous.filter((item) => item.id !== track.id), track]); }, []));
  const tracks = useMemo(() => mergeCloudTracks(storedTracks, cloud.tracks), [storedTracks, cloud.tracks]);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<LibraryView>('all');
  const [search, setSearch] = useState('');
  const [listPage, setListPage] = useState(0);
  const [currentId, setCurrentId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [audioAdvancing, setAudioAdvancing] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('tingyu-volume') ?? '0.7'));
  const [mode, setMode] = useState<PlaybackMode>(() => { const saved = localStorage.getItem('tingyu-play-mode'); return saved === 'shuffle' || saved === 'one' ? saved : 'list'; });
  const [fadeDuration, setFadeDuration] = useState(() => { const saved = Number(localStorage.getItem('tingyu-fade-duration') ?? 500); return Number.isFinite(saved) ? Math.max(0, Math.min(2000, saved)) : 500; });
  const [sleepTimer, setSleepTimer] = useState<SleepState>(null);
  const [now, setNow] = useState(Date.now);
  const [nativeActive, setNativeActive] = useState(false);
  const [nativeProgress, setNativeProgress] = useState('');
  const [alignmentBusy, setAlignmentBusy] = useState(false);
  const nativeActiveRef = useRef(false);
  const nativePreparing = useRef(false);
  const nativeAutoAttempt = useRef(false);
  const nativePreparation = useRef<AbortController | null>(null);
  const nativeError = useRef('');
  const nativeSleepCommand = useRef<number | null>(null);
  const nativeView = useRef({ tracks, currentId, queue: [] as string[], mode, volume, fadeDuration, playing });
  const sleepRef = useRef<SleepState>(null);
  const sleepStopped = useRef(false);
  const fadeRef = useRef<ReturnType<typeof createAudioFader> | null>(null);
  const playbackSettings = useRef({ volume, fadeDuration });
  playbackSettings.current = { volume, fadeDuration };
  const [queue, setQueue] = useState<string[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [lyricFiles, setLyricFiles] = useState<File[]>([]);
  const [fullLyrics, setFullLyrics] = useState(false);
  const [showTranslation, setShowTranslation] = useState(() => localStorage.getItem('tingyu-translation') !== 'false');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const [storageInfo, setStorageInfo] = useState('正在统计…');
  const [storageProgress, setStorageProgress] = useState('');
  const [desktopState, setDesktopState] = useState<DesktopState | null>(null);
  const [season, setSeason] = useState<SeasonChoice>(() => {
    const saved = localStorage.getItem('tingyu-season') || 'auto';
    return saved in seasonLabels ? saved as SeasonChoice : 'auto';
  });
  const [aiConfig, setAIConfig] = useState<AIConfig>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('tingyu-ai-config') || '{}');
      return { url: typeof stored.url === 'string' ? stored.url : defaultAIConfig.url, model: typeof stored.model === 'string' ? stored.model : defaultAIConfig.model, audioModel: typeof stored.audioModel === 'string' ? stored.audioModel : 'whisper-1', autoAlign: typeof stored.autoAlign === 'boolean' ? stored.autoAlign : undefined, key: '' };
    } catch { return { ...defaultAIConfig }; }
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const lyricInputRef = useRef<HTMLInputElement>(null);
  const lyricRef = useRef<HTMLDivElement>(null);
  const playAfterLoad = useRef(false);
  const audioSourceId = useRef('');
  const playIntent = useRef(0);
  const importLock = useRef(false);
  const sourceTransferring = useRef(false);
  const librarySwitching = useRef(false);
  const importController = useRef<AbortController | null>(null);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceAuto = useSourceAutoSync(storedTracks, ready, !!busy || !!storageProgress || !!nativeProgress || cloud.caching || alignmentBusy);
  const current = tracks.find((track) => track.id === currentId);
  nativeView.current = { tracks, currentId, queue, mode, volume, fadeDuration, playing };
  const audioUrl = useBlobUrl(current?.audio);
  const activeLine = activeLyricIndex(current?.lyrics ?? [], position);
  const favorites = tracks.filter((track) => track.favorite).length;

  const notify = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(''), 6500);
  }, []);
  useEffect(() => {
    const switching = (event: Event) => {
      const active = (event as CustomEvent<boolean>).detail;
      librarySwitching.current = active;
      if (active) { nativePreparation.current?.abort(); playAfterLoad.current = false; fadeRef.current?.pause(true); setPlaying(false); }
      setBusy(active ? '正在校验并切换音乐库…' : '');
    };
    const sourceTransfer = (event: Event) => { sourceTransferring.current = (event as CustomEvent<boolean>).detail; setBusy(sourceTransferring.current ? '在线曲库传输中…' : ''); };
    window.addEventListener('xianqiji-source-transferring', sourceTransfer);
    window.addEventListener('tingyu-library-switching', switching);
    return () => { window.removeEventListener('tingyu-library-switching', switching); window.removeEventListener('xianqiji-source-transferring', sourceTransfer); };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => { void startupUpdateCheck().then((state) => { if (state?.phase === 'available') notify(`发现新版本 v${state.release?.version}，可在偏好设置 → 软件更新中查看。`); }).catch(() => {}); }, 8000);
    return () => clearTimeout(timer);
  }, [notify]);

  useEffect(() => {
    if (!audioRef.current) return;
    const fader = createAudioFader(audioRef.current, () => playbackSettings.current.volume, () => playbackSettings.current.fadeDuration);
    fadeRef.current = fader;
    return () => { fader.dispose(); fadeRef.current = null; };
  }, []);
  const beginPlayback = useCallback(() => { if (librarySwitching.current) return; sleepStopped.current = false; void fadeRef.current?.play().catch(() => notify('此歌曲无法播放，可能是音频损坏或设备不支持该编码。')); }, [notify]);
  const clearSleep = useCallback(() => { if (nativeActiveRef.current) nativeSleepCommand.current = 0; sleepRef.current = null; setSleepTimer(null); }, []);
  const checkSleep = useCallback(() => {
    const timer = sleepRef.current;
    if (nativeActiveRef.current) return false;
    if (!timer || Date.now() < timer.deadline) return false;
    if (timer.behavior === 'immediate' || audioRef.current?.paused || audioRef.current?.ended) {
      sleepStopped.current = true;
      fadeRef.current?.pause(true); clearSleep(); notify('睡眠定时已结束，音乐已停止。'); return true;
    }
    if (!timer.pending) { const pending = { ...timer, pending: true }; sleepRef.current = pending; setSleepTimer(pending); }
    return false;
  }, [clearSleep, notify]);
  useEffect(() => {
    if (!sleepTimer) return;
    const tick = () => { setNow(Date.now()); checkSleep(); };
    const interval = setInterval(tick, 500);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', tick); };
  }, [sleepTimer, checkSleep]);
  useEffect(() => { void loadSavedKey().then(({ key }) => { if (key) setAIConfig((previous) => ({ ...previous, key })); }).catch((error) => notify(error.message)); }, [notify]);

  const nativeControl = useCallback((action: string, value?: number, text?: string) => {
    void androidPlayer.control({ action, value, text }).catch((error) => notify(error.message));
  }, [notify]);
  useEffect(() => {
    if (!isAndroidPlayer()) return;
    let active = true;
    let remove: (() => void) | undefined;
    const receive = (state: AndroidPlaybackState) => {
      if (!active || librarySwitching.current) return;
      for (const id of state.cloudPlayed || []) {
        if (nativeView.current.tracks.find((track) => track.id === id)?.cloud) window.dispatchEvent(new CustomEvent('xianqiji-cloud-played', { detail: id }));
        else if (nativeView.current.tracks.some((track) => track.id === id)) void androidPlayer.control({ action: 'cached', text: id }).catch(() => {});
      }
      if (state.active && state.id) {
        const attaching = !nativeActiveRef.current;
        nativeActiveRef.current = true; setNativeActive(true); fadeRef.current?.pause(true);
        setPlaying(state.playing === true); setPosition(state.position ?? 0); setDuration(state.duration ?? 0);
        if (state.id !== nativeView.current.currentId) { setCurrentId(state.id); localStorage.setItem('tingyu-current', state.id); }
        if (attaching && state.mode) setMode(state.mode);
        if (attaching && typeof state.volume === 'number') setVolume(state.volume);
        if (nativeSleepCommand.current === null || nativeSleepCommand.current === (state.deadline || 0)) {
          nativeSleepCommand.current = null;
          if (!state.deadline && sleepRef.current) clearSleep();
          if (state.deadline && (!sleepRef.current || sleepRef.current.pending !== (Date.now() >= state.deadline))) { const timer: NonNullable<SleepState> = { deadline: state.deadline, behavior: state.finishTrack ? 'finish-track' : 'immediate', pending: Date.now() >= state.deadline }; sleepRef.current = timer; setSleepTimer(timer); }
        }
        if (state.error && state.error !== nativeError.current) notify(state.error);
        nativeError.current = state.error || '';
      } else if (nativeActiveRef.current) { nativeActiveRef.current = false; setNativeActive(false); setPlaying(false); }
    };
    void androidPlayer.addListener('state', receive).then((listener) => { if (!active) void listener.remove(); else remove = () => void listener.remove(); });
    const refresh = () => { if (!document.hidden) void androidPlayer.state().then(receive).catch(() => {}); };
    refresh(); document.addEventListener('visibilitychange', refresh);
    return () => { active = false; remove?.(); document.removeEventListener('visibilitychange', refresh); nativePreparation.current?.abort(); };
  }, [notify, clearSleep]);
  const startNativeQueue = useCallback(async (identifier?: string, nextQueue?: string[]) => {
    if (!isAndroidPlayer() || nativePreparing.current || librarySwitching.current) return;
    nativePreparing.current = true;
    const wasNative = nativeActiveRef.current;
    let handingOff = false;
    const controller = new AbortController(); nativePreparation.current = controller;
    try {
      const view = nativeView.current;
      const identifiers = [...(nextQueue?.length ? nextQueue : view.queue.length ? view.queue : view.tracks.map((track) => track.id))];
      if (identifier && !identifiers.includes(identifier)) identifiers.push(identifier);
      const selected = identifiers.map((id) => view.tracks.find((track) => track.id === id)).filter((track): track is Track => !!track && (!track.cloud || track.cloud.publicRead));
      await prepareAndroidQueue(selected, setNativeProgress, controller.signal);
      controller.signal.throwIfAborted();
      const latest = nativeView.current;
      const id = identifier || latest.currentId;
      if (!selected.some((track) => track.id === id)) return;
      if (!identifier && !latest.playing) return;
      await androidPlayer.notifications();
      const position = identifier ? 0 : audioRef.current?.currentTime ?? 0;
      handingOff = true;
      nativeActiveRef.current = true; setNativeActive(true); fadeRef.current?.pause(true);
      await androidPlayer.setQueue(androidQueueOptions(selected, id, position, true, latest.mode, latest.volume, latest.fadeDuration, sleepRef.current));
      notify('后台播放已就绪，可锁屏或切换应用；通知栏可控制播放。');
    } catch (error) {
      if (!controller.signal.aborted) { nativeActiveRef.current = wasNative; setNativeActive(wasNative); if (handingOff && !wasNative) beginPlayback(); notify(`后台准备未完成，仍可前台播放：${error instanceof Error ? error.message : '请检查空间'}`); }
    } finally { nativePreparing.current = false; nativePreparation.current = null; setNativeProgress(''); }
  }, [notify, beginPlayback]);
  useEffect(() => {
    if (!isAndroidPlayer()) return;
    if (!playing && !nativeActive && !nativePreparing.current) nativeAutoAttempt.current = false;
    if (playing && !nativeActive && !nativePreparing.current && !nativeAutoAttempt.current) { nativeAutoAttempt.current = true; void startNativeQueue(); }
  }, [playing, nativeActive, startNativeQueue]);
  useEffect(() => { if (nativeActive) nativeControl('volume', volume); }, [nativeActive, volume, nativeControl]);
  useEffect(() => { if (nativeActive) nativeControl('mode', undefined, mode); }, [nativeActive, mode, nativeControl]);
  useEffect(() => { if (nativeActive) nativeControl('fade', fadeDuration); }, [nativeActive, fadeDuration, nativeControl]);
  useEffect(() => { if (nativeActive) { nativeSleepCommand.current = sleepTimer?.deadline ?? 0; nativeControl('sleep', sleepTimer?.deadline ?? 0, sleepTimer?.behavior ?? 'immediate'); } }, [nativeActive, sleepTimer?.deadline, sleepTimer?.behavior, nativeControl]);

  useEffect(() => {
    const progress = (event: Event) => setStorageProgress((event as CustomEvent<string>).detail);
    window.addEventListener('tingyu-storage-progress', progress);
    getTracks().then((stored) => {
      setTracks(stored);
      const lastId = localStorage.getItem('tingyu-current');
      if (stored.some((track) => track.id === lastId)) setCurrentId(lastId!);
      setReady(true);
    }).catch(() => { notify('无法读取本地音乐库，请检查设备存储空间或浏览器权限。'); setReady(true); });
    return () => { clearTimeout(messageTimer.current); window.removeEventListener('tingyu-storage-progress', progress); };
  }, [notify]);

  const visibleTracks = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = tracks.filter((track) => (view !== 'favorites' || track.favorite) && (view !== 'recent' || track.lastPlayed) && (!query || `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(query)));
    return view === 'recent' ? filtered.sort((first, second) => (second.lastPlayed ?? 0) - (first.lastPlayed ?? 0)) : filtered;
  }, [tracks, view, search]);

  const pagedTracks = libraryPage(visibleTracks, listPage);
  useEffect(() => { setListPage(0); }, [view, search]);

  const updateTrack = useCallback(async (id: string, patch: Partial<Omit<Track, 'id'>>) => {
    if (librarySwitching.current || sourceTransferring.current) return false;
    if (tracks.find((track) => track.id === id)?.cloud) { cloud.patch(id, patch); return true; }
    try {
      const track = await patchTrack(id, patch);
      setTracks((previous) => previous.map((item) => item.id === track.id ? { ...track, audio: item.audio, cover: track.cover ?? item.cover } : item));
      return true;
    } catch { notify('保存失败，歌曲可能已移除或设备空间不足。'); return false; }
  }, [notify, tracks, cloud.patch]);

  const automaticAlignment = useAutomaticAlignment(storedTracks, ready, aiConfig, !!busy || !!storageProgress || !!nativeProgress || cloud.caching || sourceAuto.state.running || modal === 'online' || modal === 'lyrics', updateTrack, setAlignmentBusy);

  const playTrack = useCallback((track: Track, nextQueue?: string[]): void => {
    if (librarySwitching.current) return;
    const intent = ++playIntent.current;
    if (track.cloud) {
      const cached = cloud.cache({ ...track, lastPlayed: Date.now() });
      if (!track.cloud.publicRead) { notify('此私密曲库将先保存当前这一首到本地音乐库，再开始播放。'); void cached.then((saved) => { if (saved && playIntent.current === intent) playTrack(saved, nextQueue); }); return; }
    }
    if (nextQueue) setQueue(nextQueue);
    if (nativeActiveRef.current) { void startNativeQueue(track.id, nextQueue); void updateTrack(track.id, { lastPlayed: Date.now() }); return; }
    if (track.id === currentId && audioRef.current?.src) {
      if (audioRef.current.ended) audioRef.current.currentTime = 0;
      beginPlayback();
    } else {
      playAfterLoad.current = true;
      setPosition(0);
      setDuration(track.duration);
      setCurrentId(track.id);
      localStorage.setItem('tingyu-current', track.id);
    }
    void updateTrack(track.id, { lastPlayed: Date.now() });
  }, [currentId, beginPlayback, updateTrack, startNativeQueue, cloud.cache, notify]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    fadeRef.current?.reset();
    if (!audioUrl) { audio.pause(); audio.removeAttribute('src'); audio.load(); return; }
    const sameTrack = audioSourceId.current === currentId;
    const restorePosition = sameTrack ? audio.currentTime : 0;
    const resume = sameTrack && !audio.paused;
    const restore = () => { if (restorePosition > 0 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(restorePosition, audio.duration); };
    audio.addEventListener('loadedmetadata', restore, { once: true });
    audioSourceId.current = currentId;
    audio.src = audioUrl;
    audio.load();
    if (nativeActiveRef.current) { playAfterLoad.current = false; return () => audio.removeEventListener('loadedmetadata', restore); }
    if (playAfterLoad.current || resume) {
      playAfterLoad.current = false;
      beginPlayback();
    }
    return () => audio.removeEventListener('loadedmetadata', restore);
  }, [audioUrl, beginPlayback]);

  useEffect(() => {
    fadeRef.current?.setVolume();
    localStorage.setItem('tingyu-volume', String(volume));
  }, [volume]);
  useEffect(() => { localStorage.setItem('tingyu-play-mode', mode); }, [mode]);
  useEffect(() => { localStorage.setItem('tingyu-fade-duration', String(fadeDuration)); }, [fadeDuration]);

  useEffect(() => { localStorage.setItem('tingyu-translation', String(showTranslation)); }, [showTranslation]);
  useEffect(() => { localStorage.setItem('tingyu-season', season); }, [season]);
  useEffect(() => () => importController.current?.abort(), []);

  useEffect(() => {
    const container = lyricRef.current;
    const line = container?.querySelector<HTMLElement>('[data-active="true"]');
    if (container && line) container.scrollTo({ top: line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2, behavior: 'smooth' });
  }, [activeLine, fullLyrics]);

  const stepTrack = useCallback((direction: number) => {
    if (nativeActiveRef.current) { nativeControl(direction > 0 ? 'next' : 'previous'); return; }
    const queueTracks = (queue.length ? queue : tracks.map((track) => track.id)).map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track));
    if (!queueTracks.length) return;
    const identifier = nextTrackId(queueTracks.map((track) => track.id), currentId, direction, mode);
    const next = queueTracks.find((track) => track.id === identifier);
    if (next) playTrack(next);
  }, [queue, tracks, currentId, mode, playTrack, nativeControl]);

  const togglePlay = useCallback(() => {
    if (nativeActiveRef.current) { nativeControl('toggle'); return; }
    const audio = audioRef.current;
    if (!current) {
      if (visibleTracks[0]) playTrack(visibleTracks[0], visibleTracks.map((track) => track.id));
      else setModal('import');
      return;
    }
    if (!fadeRef.current?.isPlaying() || audio?.paused) beginPlayback();
    else fadeRef.current.pause();
  }, [current, visibleTracks, playTrack, beginPlayback, nativeControl]);

  const seek = useCallback((seconds: number) => {
    if (nativeActiveRef.current) { nativeControl('seek', Math.max(0, Math.min(duration, seconds))); setPosition(seconds); return; }
    if (!audioRef.current || !Number.isFinite(duration) || duration <= 0) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, seconds));
    setPosition(audioRef.current.currentTime);
  }, [duration, nativeControl]);

  useEffect(() => {
    if (nativeActive || !playing) return;
    // Sample the actual audio clock, including seeks/stalls; timeupdate alone
    // can arrive only a few times a second and visibly lags short syllables.
    const timer = setInterval(() => {
      const audio = audioRef.current;
      if (audio && !nativeActiveRef.current) setPosition(audio.currentTime);
    }, 40);
    return () => clearInterval(timer);
  }, [playing, nativeActive]);

  useEffect(() => {
    const bridge = window.tingyuDesktop;
    if (!bridge) return;
    void bridge.getState().then(setDesktopState).catch(() => notify('桌面歌词状态读取失败。'));
    return bridge.onState(setDesktopState);
  }, [notify]);

  useEffect(() => {
    const bridge = window.tingyuDesktop;
    if (!bridge) return;
    const line = current?.lyrics[activeLine];
    const next = current?.lyrics[activeLine + 1];
    const previous = current?.lyrics[activeLine - 1];
    bridge.updateSnapshot({ title: current?.title ?? '', artist: current?.artist ?? '', text: line?.text ?? '', translation: line?.translation ?? '', nextText: next?.text ?? (current?.lyrics.length && !current.lyrics.some((item) => item.time >= 0) ? '纯文本歌词，请在详情页阅读' : ''), previousText: previous?.text ?? '', lineIndex: Math.max(0, activeLine), lineStart: Math.max(0, line?.time ?? 0), lineEnd: next && next.time >= 0 ? next.time : duration, words: line ? timedWords(line) : undefined, advancing: nativeActive ? playing : audioAdvancing, playbackRate: audioRef.current?.playbackRate ?? 1, position, duration, playing, showTranslation, favorite: current?.favorite ?? false, hasTrack: !!current, volume, mode });
  }, [current, activeLine, position, duration, playing, audioAdvancing, nativeActive, showTranslation, volume, mode]);

  useEffect(() => window.tingyuDesktop?.onControl((action) => {
    if (action === 'play-pause') togglePlay();
    if (action === 'previous') stepTrack(-1);
    if (action === 'next') stepTrack(1);
    if (action === 'settings') { setFullLyrics(false); setModal('settings'); }
  }), [togglePlay, stepTrack]);

  useEffect(() => window.tingyuDesktop?.onTrayControl((action, value) => {
    if (action === 'toggle-favorite' && current) void updateTrack(current.id, { favorite: !current.favorite });
    if (action === 'cycle-mode') setMode(nextMode);
    if (action === 'volume-up') setVolume((previous) => Math.min(1, previous + 0.05));
    if (action === 'volume-down') setVolume((previous) => Math.max(0, previous - 0.05));
    if (action === 'set-volume' && typeof value === 'number' && Number.isFinite(value)) setVolume(Math.max(0, Math.min(1, value)));
  }), [current, updateTrack]);

  async function saveAIConfig(config: AIConfig, remember: boolean) {
    await persistKey(config.key, remember);
    const { key: _key, ...preferences } = config;
    localStorage.setItem('tingyu-ai-config', JSON.stringify(preferences));
    setAIConfig(config);
    window.dispatchEvent(new Event('xianqiji-ai-config-changed'));
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modal || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      if (event.code === 'ArrowRight') { event.preventDefault(); seek(position + 5); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); seek(position - 5); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, position, modal]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !current || nativeActive) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.artist, album: current.album });
    navigator.mediaSession.setActionHandler('play', beginPlayback);
    navigator.mediaSession.setActionHandler('pause', () => fadeRef.current?.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => stepTrack(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => stepTrack(1));
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    return () => { for (const action of ['play', 'pause', 'previoustrack', 'nexttrack'] as const) navigator.mediaSession.setActionHandler(action, null); };
  }, [current, playing, stepTrack, beginPlayback, nativeActive]);

  useEffect(() => {
    if (!modal && !fullLyrics) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (modal === 'online' || modal === 'lyrics' || modal === 'export' || modal === 'transfers') return;
      if (modal) { if (!importLock.current) setModal(null); }
      else setFullLyrics(false);
    };
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
      const focusable = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusTimer = setTimeout(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)?.querySelector<HTMLElement>('button')?.focus(), 0);
    document.addEventListener('keydown', onEscape);
    document.addEventListener('keydown', onTab);
    return () => { clearTimeout(focusTimer); document.removeEventListener('keydown', onEscape); document.removeEventListener('keydown', onTab); previousFocus?.focus(); };
  }, [modal, fullLyrics]);

  useEffect(() => {
    if (modal !== 'settings') return;
    if (window.tingyuDesktop) { setStorageInfo(`音频与封面 ${((tracks.reduce((total, track) => total + track.audio.size + (track.cover?.size || 0), 0)) / 1024 / 1024).toFixed(1)} MB · 保存目录见下方路径设置`); return; }
    if (!navigator.storage?.estimate) { setStorageInfo('当前环境不提供存储统计'); return; }
    navigator.storage.estimate().then((estimate) => setStorageInfo(`已使用 ${((estimate.usage ?? 0) / 1024 / 1024).toFixed(1)} MB · 可用约 ${((estimate.quota ?? 0) / 1024 / 1024 / 1024).toFixed(1)} GB`)).catch(() => setStorageInfo('暂时无法获取存储统计'));
  }, [modal, tracks.length]);

  async function handleImport(files: File[], resumeTask?: ImportTask) {
    if (!files.length || importLock.current || sourceTransferring.current) return;
    if (cloud.caching) { notify('正在缓存到当前音乐库，请稍后导入，或先点击“停止缓存”。'); return; }
    if (!resumeTask && files.every((file) => /\.(lrc|yrc|txt)$/i.test(file.name))) {
      setLyricFiles(files); setModal('lyrics');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    importLock.current = true;
    setModal('import');
    setBusy('正在准备导入…');
    importController.current = new AbortController();
    try {
      const fingerprint = await filesFingerprint(files);
      const prior = (await getTransfers()).find((task): task is ImportTask => task.kind === 'import' && task.status !== 'completed' && task.fingerprint === fingerprint);
      const task = resumeTask ?? prior ?? await createImportTask(files);
      const result = await runImportTask(task, files, importController.current.signal, setBusy);
      const stored = await getTracks();
      setTracks((previous) => stored.map((track) => ({ ...track, audio: previous.find((item) => item.id === track.id)?.audio ?? track.audio })));
      setView('all');
      setSearch('');
      setModal(result.status === 'completed' ? null : 'transfers');
      void navigator.storage?.persist?.().catch(() => false);
      notify(result.status === 'completed' ? `导入完成：${result.completed.length} 首。${result.warnings.length ? result.warnings[0] : ''}` : result.error || `导入已暂停，已保存 ${result.completed.length} 首；在传输任务中继续。`);
    } catch (error) { notify(error instanceof Error ? error.message : '导入失败，请检查文件与存储空间。'); }
    finally { importLock.current = false; setBusy(''); if (inputRef.current) inputRef.current.value = ''; if (audioInputRef.current) audioInputRef.current.value = ''; }
  }

  async function loadDemo() {
    if (importLock.current || sourceTransferring.current) return;
    setBusy('正在加载示例…');
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}demo/弦栖霁示例.zip`);
      if (!response.ok) throw new Error('示例文件未找到');
      await handleImport([new File([await response.blob()], '弦栖霁示例.zip', { type: 'application/zip' })]);
    } catch { notify('示例加载失败，请直接导入你的音乐包。'); }
    finally { setBusy(''); }
  }

  const renderLyrics = (expanded = false) => <div className={`lyrics-content ${expanded ? 'expanded' : ''}`} ref={lyricRef}>
    {current?.lyrics.length ? <>
      <div className="lyric-top-space" />
      {current.lyrics.map((line, index) => <button key={`${line.time}-${index}`} className={`lyric-line ${index === activeLine ? 'active' : ''}`} data-active={index === activeLine} onClick={() => { if (line.time >= 0) seek(line.time); }} disabled={line.time < 0}>
        <TimedLyricText text={line.text} words={timedWords(line)} position={position} active={index === activeLine} />{showTranslation && line.translation && <small>{line.translation}</small>}
      </button>)}
      <div className="lyric-top-space" />
    </> : <div className="lyric-empty"><Disc3 size={36} /><p>{current ? '这首歌还没有歌词' : '每一首歌，都有回响'}</p><small>{current ? '导入同名 LRC，字句随音乐流动' : '选一首喜欢的，开始聆听'}</small></div>}
  </div>;

  return <div className="app" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void handleImport(Array.from(event.dataTransfer.files)); }}>
    <input ref={inputRef} className="hidden-input" type="file" multiple accept=".zip,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.lrc,.yrc,.txt,.jpg,.jpeg,.png,.webp" aria-label="选择音乐压缩包或歌曲文件" onChange={(event) => void handleImport(Array.from(event.target.files ?? []))} />
    <input ref={audioInputRef} className="hidden-input" type="file" multiple accept=".mp3,.flac,.wav,.m4a,.aac,.ogg,.opus" aria-label="选择单独音频文件" onChange={(event) => void handleImport(Array.from(event.target.files ?? []))} />
    <input ref={lyricInputRef} className="hidden-input" type="file" multiple accept=".lrc,.yrc,.txt" aria-label="选择单独歌词文件" onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) { setLyricFiles(files); setModal('lyrics'); } event.target.value = ''; }} />
    <audio ref={audioRef} preload="metadata" onPlay={() => { if (!nativeActiveRef.current) setPlaying(true); }} onPause={() => { setAudioAdvancing(false); if (!nativeActiveRef.current) setPlaying(false); }} onPlaying={() => setAudioAdvancing(true)} onWaiting={() => setAudioAdvancing(false)} onSeeking={() => setAudioAdvancing(false)} onSeeked={(event) => { setPosition(event.currentTarget.currentTime); setAudioAdvancing(!event.currentTarget.paused && event.currentTarget.readyState >= 3); }} onTimeUpdate={(event) => { if (!nativeActiveRef.current) { setPosition(event.currentTarget.currentTime); checkSleep(); } }} onLoadedMetadata={(event) => { if (nativeActiveRef.current) return; const nextDuration = event.currentTarget.duration; setDuration(Number.isFinite(nextDuration) ? nextDuration : 0); }} onEnded={() => { if (nativeActiveRef.current || sleepStopped.current) return; if (sleepRef.current && Date.now() >= sleepRef.current.deadline) { fadeRef.current?.pause(true); clearSleep(); notify('睡眠定时已结束，音乐已停止。'); return; } if (mode === 'one' && audioRef.current) { audioRef.current.currentTime = 0; beginPlayback(); } else stepTrack(1); }} onError={() => { if (!nativeActiveRef.current && audioRef.current?.getAttribute('src')) notify('音频解码失败。请尝试 MP3 / WAV 格式，或检查原文件是否完整。'); }} />
    <StartupScreen ready={ready} />{aiConfig.autoAlign && (alignmentBusy || automaticAlignment.state.failed > 0 || automaticAlignment.state.partial > 0) && modal !== 'settings' && <div className="source-auto-banner" role="status">{automaticAlignment.state.message}{alignmentBusy ? <button onClick={automaticAlignment.pause}>暂停生成</button> : <button onClick={() => setModal('settings')}>查看 AI 配置</button>}</div>}{cloud.message && cloud.caching && <div className="cloud-cache-banner" role="status">{cloud.message}<button onClick={cloud.stop}>停止缓存</button></div>}{sourceAuto.state.running && modal !== 'settings' && <div className="source-auto-banner" role="status">{sourceAuto.state.message}</div>}{nativeProgress && <div className="native-playback-progress" role="status">{nativeProgress}<small>准备完成后才启用锁屏连播；额外保存一份校验过的原音频，会占用相应空间。</small></div>}<aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setView('all'); setSearch(''); }} aria-label="弦栖霁首页"><span className="brand-symbol"><Headphones size={23} /></span><span>弦栖霁<span className="brand-en">XIANQIJI</span></span><span className="brand-dot">●</span></a>
      <div className="nav-label">你的音乐世界</div>
      <nav aria-label="音乐导航">
        <button className={view === 'all' ? 'selected' : ''} onClick={() => { setView('all'); setSearch(''); }}><Library size={19} />我的音乐<span className="nav-count">{tracks.length.toString().padStart(2, '0')}</span></button>
        <button className={view === 'favorites' ? 'selected' : ''} onClick={() => { setView('favorites'); setSearch(''); }}><Heart size={19} />我喜欢的<span className="nav-count">{favorites.toString().padStart(2, '0')}</span></button>
        <button className={view === 'recent' ? 'selected' : ''} onClick={() => { setView('recent'); setSearch(''); }}><Disc3 size={19} />最近播放</button>
      </nav>
      <div className="sidebar-divider" />
      <div className="nav-label">音乐管理</div>
      <button className="side-link" onClick={() => setModal('import')}><FolderInput size={19} />导入音乐</button>
      <button className="side-link" onClick={() => setModal('export')}><Download size={19} />导出音乐</button>
      <button className="side-link" onClick={() => setModal('transfers')}><FolderInput size={19} />传输任务</button>
      <button className="side-link" onClick={() => setModal('settings')}><Settings2 size={19} />偏好设置</button>
      <div className="sidebar-bottom"><div className="offline-card"><span className="online-dot" />本地聆听 · 联网补全<small>你的音乐，随身带走。</small></div><div className="version">XIANQIJI MUSIC <span>v{appVersion}</span></div></div>
    </aside>

    <main className="main">
      <SeasonAtmosphere choice={season} />
      {storageProgress && <div className="storage-migration-banner" role="status"><LoaderCircle className="spin" size={18} /><span>{storageProgress}<small>正在读取或迁移音乐库，请勿关闭程序或移除磁盘；旧记录只在完整校验后清理。</small></span></div>}
      <header className="topbar"><div className="breadcrumbs">音乐库 <span>/</span> <strong>{viewNames[view]}</strong></div><div className="topbar-right"><label className="search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索歌曲、歌手、专辑" aria-label="搜索音乐" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={14} /></button>}</label><button className="icon-button settings-button" onClick={() => setModal('settings')} aria-label="偏好设置"><Settings2 size={19} /></button><span className="profile"><Headphones size={18} /></span></div></header>
      <div className="page-scroll">
        <section className="page-heading"><div><div className="eyebrow">YOUR PERSONAL SOUNDTRACK</div><h1>{viewNames[view]}<span className="heading-dot">.</span></h1><p>{view === 'all' ? '让喜欢的音乐，留在身边。' : view === 'favorites' ? '那些让你忍不住单曲循环的瞬间。' : '重温最近陪伴你的旋律。'}</p></div><button className="button outline import-top" onClick={() => setModal('import')}><Upload size={16} />导入音乐</button></section>
        {view === 'all' && !search && <section className="hero"><div className="hero-text"><span className="hero-kicker"><span />为热爱，留一座岛</span><h2>世界很大，<br />此刻只听<span>你喜欢的。</span></h2><p>收藏每一段旋律，让音乐与字句一起抵达。</p><button className="button hero-button" onClick={() => tracks.length ? playTrack(tracks[0], tracks.map((track) => track.id)) : setModal('import')}>{tracks.length ? <Play size={15} fill="currentColor" /> : <Upload size={15} />}{tracks.length ? '开始聆听' : '导入我的音乐'}<ArrowRight size={16} /></button><span className="hero-index">VOL. 01 <span> / </span> YOUR OWN FREQUENCY</span></div><div className="hero-art" aria-hidden="true"><div className={`vinyl ${playing ? 'spinning' : ''}`}><div className="vinyl-label"><span>弦栖霁</span><small>33⅓ RPM</small><i /></div></div><div className="record-sleeve"><div className="sleeve-sun" /><div className="sleeve-hills" /><div className="sleeve-title">SLOW<br />MOMENTS<span>把日子调成喜欢的频率</span></div><span className="sleeve-bottom">XIANQIJI RECORDS — 001</span></div><span className="hero-note">GOOD MUSIC. YOUR PACE.</span></div></section>}
        <div className="content-grid">
          <section className="library-section"><div className="section-top"><div className="section-title"><h2>{search ? '搜索结果' : view === 'all' ? '全部歌曲' : viewNames[view]}</h2><span>{visibleTracks.length} 首</span></div><div className="section-actions"><button className="button primary" disabled={!visibleTracks.length} onClick={() => playTrack(visibleTracks[mode === 'shuffle' ? Math.floor(Math.random() * visibleTracks.length) : 0], visibleTracks.map((track) => track.id))}><Play size={14} fill="currentColor" />播放全部</button><button className="icon-button library-mode-button" aria-label={`播放全部模式：${modeLabels[mode]}，点击切换`} title={modeLabels[mode]} onClick={() => setMode(nextMode)}>{mode === 'shuffle' ? <Shuffle size={17} /> : mode === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}</button></div></div>
            <div className="track-table"><div className="table-header"><span>#</span><span>歌曲 / 歌手</span><span className="album-column">专辑</span><span>时长</span><span /></div>
              {!ready ? <div className="empty-state"><LoaderCircle className="spin" /><p>正在打开你的音乐库…</p></div> : !visibleTracks.length ? <div className="empty-state"><div className="empty-icon">{view === 'favorites' ? <Heart size={28} /> : <Music2 size={29} />}</div><h3>{search ? '没有找到这段旋律' : view === 'favorites' ? '把心动的歌，留在这里' : view === 'recent' ? '你的聆听故事，从这里开始' : '你的私人音乐库，等待第一首歌'}</h3><p>{search ? '换个歌名、歌手或专辑试试看' : view === 'favorites' ? '点击歌曲旁的爱心，收藏你喜欢的音乐' : view === 'recent' ? '播放一首歌曲，就能在这里找到它' : '导入 ZIP 音乐包，歌曲、封面和双语歌词自动归位'}</p>{view === 'all' && !search && <div className="empty-actions"><button className="button primary" onClick={() => inputRef.current?.click()}><Upload size={15} />选择音乐包</button><button className="text-button" disabled={!!busy} onClick={() => void loadDemo()}>先听听示例 <ArrowRight size={14} /></button></div>}</div> : pagedTracks.tracks.map((track, index) => <div className={`track-row ${currentId === track.id ? 'current' : ''}`} key={track.id}>
                <button className="row-number" aria-label={`播放 ${track.title}`} onClick={() => playTrack(track, visibleTracks.map((item) => item.id))}>{currentId === track.id && playing ? <span className="equalizer"><i /><i /><i /></span> : <><span className="row-index">{String(pagedTracks.offset + index + 1).padStart(2, '0')}</span><Play className="row-play" size={14} fill="currentColor" /></>}</button>
                <button className="track-name" onClick={() => playTrack(track, visibleTracks.map((item) => item.id))}><Artwork track={track} /><span><strong>{track.title}<span className="format-tag">{track.cloud ? '云端' : '本地'} · {track.format}</span></strong><small>{track.artist}{track.lyrics.some((line) => line.translation) && <span className="translation-tag">双语</span>}</small></span></button>
                <span className="album-column album-name" title={track.album}>{track.album}</span><span className="track-time">{formatTime(currentId === track.id && duration ? duration : track.duration)}</span><div className="track-actions"><button className={`icon-button favorite ${track.favorite ? 'liked' : ''}`} aria-label={`${track.favorite ? '取消收藏' : '收藏'} ${track.title}`} onClick={() => void updateTrack(track.id, { favorite: !track.favorite })}><Heart size={16} fill={track.favorite ? 'currentColor' : 'none'} /></button>{view === 'favorites' && <button className="icon-button remove-favorite" title="只取消收藏，不删除音频和歌词" aria-label={`移出我喜欢 ${track.title}`} onClick={() => void updateTrack(track.id, { favorite: false })}><Trash2 size={15} /></button>}</div>
              </div>)}
            </div>
            {pagedTracks.pages > 1 && <nav className="library-pagination" aria-label="歌曲分页"><button className="button outline" disabled={pagedTracks.page === 0} onClick={() => setListPage(pagedTracks.page - 1)}>上一页</button><span aria-live="polite">第 {pagedTracks.page + 1} / {pagedTracks.pages} 页 · 共 {visibleTracks.length} 首</span><button className="button outline" disabled={pagedTracks.page + 1 >= pagedTracks.pages} onClick={() => setListPage(pagedTracks.page + 1)}>下一页</button></nav>}
            <div className="library-footnote"><span className="online-dot" />本地储存 · 离线可听<span className="footnote-right">{tracks.length ? `${tracks.length} 首属于你的旋律` : '从一首歌开始，慢慢收藏整个世界'}</span></div>
            <div className="import-strip"><div className="strip-icon"><FolderHeart size={22} /></div><div><strong>把你的音乐，带到弦栖霁</strong><p>ZIP 一键导入，自动匹配歌词与中文译文</p></div><button onClick={() => setModal('import')} aria-label="了解如何导入"><ArrowRight size={20} /></button></div>
          </section>
          <aside className="lyrics-card"><div className="lyrics-card-heading"><span><span className="online-dot" />此刻在听</span><button className="icon-button" aria-label="展开歌词" onClick={() => setFullLyrics(true)}><Maximize2 size={15} /></button></div><div className="now-art"><Artwork track={current} /><span className="now-art-pin" /></div><h3>{current?.title ?? '等待一段好旋律'}</h3><p className="now-artist">{current?.artist ?? '你的私人音乐时光'}</p><div className="lyric-toolbar"><span>歌词</span><div className="lyric-toolbar-actions"><button className="icon-button" aria-label="联网补全歌词" disabled={!current} onClick={() => setModal('online')}><Globe2 size={14} /></button><button className={showTranslation ? 'translation-toggle enabled' : 'translation-toggle'} aria-pressed={showTranslation} onClick={() => setShowTranslation(!showTranslation)}>译 <span>{showTranslation ? '开' : '关'}</span></button></div></div>{!fullLyrics && renderLyrics()}<div className="lyric-hint">{current?.lyricsSource || '本地优先 · 支持联网补全'}</div></aside>
        </div>
        <footer className="page-footer"><span>弦栖霁 XIANQIJI</span>音乐是生活里，温柔的留白。<span>MADE FOR YOUR EARS</span></footer>
      </div>
    </main>

    <section className="player" aria-label="音乐播放器">
      <div className="player-track"><button className="player-art-button" onClick={() => setFullLyrics(true)} aria-label="打开完整歌词"><Artwork track={current} /></button><div className="player-track-text"><strong>{current?.title ?? '听见你的热爱'}</strong><small>{current?.artist ?? '导入音乐，开启聆听'}</small></div>{current && <button className={`icon-button favorite ${current.favorite ? 'liked' : ''}`} aria-label={current.favorite ? '取消收藏当前歌曲' : '收藏当前歌曲'} onClick={() => void updateTrack(current.id, { favorite: !current.favorite })}><Heart size={18} fill={current.favorite ? 'currentColor' : 'none'} /></button>}</div>
      <div className="player-center"><div className="playback-controls"><button className={`icon-button mode-button ${mode !== 'list' ? 'enabled' : ''}`} title={mode === 'list' ? '列表循环' : mode === 'shuffle' ? '随机播放' : '单曲循环'} aria-label={`播放模式：${mode === 'list' ? '列表循环' : mode === 'shuffle' ? '随机播放' : '单曲循环'}，点击切换`} onClick={() => setMode(nextMode)}>{mode === 'shuffle' ? <Shuffle size={17} /> : mode === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}</button><button className="icon-button skip" aria-label="上一首" disabled={!tracks.length} onClick={() => stepTrack(-1)}><SkipBack size={19} fill="currentColor" /></button><button className="play-main" aria-label={playing ? '暂停' : '播放'} onClick={togglePlay}>{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button><button className="icon-button skip" aria-label="下一首" disabled={!tracks.length} onClick={() => stepTrack(1)}><SkipForward size={19} fill="currentColor" /></button><button className="icon-button lyrics-mobile-button" aria-label="展开歌词" onClick={() => setFullLyrics(true)}><Music2 size={18} /></button></div><div className="progress-control"><span>{formatTime(position)}</span><input aria-label="播放进度" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(position, duration || 1)} disabled={!current || !duration} style={{ '--progress': `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} onChange={(event) => seek(Number(event.target.value))} /><span>{formatTime(duration)}</span></div></div>
      <div className="player-extras">{sleepTimer && <button className="sleep-indicator" aria-label="查看睡眠定时" onClick={() => setModal('settings')}>{sleepTimer.pending ? '本曲后停止' : `${Math.max(0, Math.ceil((sleepTimer.deadline - now) / 60000))} 分后停止`}</button>}{desktopState && <button className={`icon-button desktop-shortcut ${desktopState.visible ? 'enabled' : ''}`} aria-label={desktopState.visible ? '关闭桌面歌词' : '开启桌面歌词'} onClick={() => void window.tingyuDesktop?.setVisible(!desktopState.visible).catch(() => notify('桌面歌词无法打开。'))}><Monitor size={19} /></button>}<button className={`icon-button lyrics-shortcut ${showTranslation ? 'enabled' : ''}`} aria-label="显示完整歌词" onClick={() => setFullLyrics(true)}>词</button><button className="icon-button volume-button" aria-label={volume ? '静音' : '取消静音'} onClick={() => setVolume(volume ? 0 : 0.7)}>{volume ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><input className="volume-slider" type="range" min="0" max="1" step="0.01" value={volume} aria-label="音量" style={{ '--progress': `${volume * 100}%` } as React.CSSProperties} onChange={(event) => setVolume(Number(event.target.value))} /><span className="player-separator" /><button className="icon-button queue-button" aria-label="播放队列" onClick={() => setModal('queue')}><ListMusic size={21} /><span>{queue.length || tracks.length}</span></button></div>
    </section>

    {fullLyrics && <div className="full-lyrics" role="dialog" aria-modal="true" aria-label="完整歌词">
      <div className="detail-toolbar"><button className="button outline close-full" onClick={() => setFullLyrics(false)}><ChevronDown size={19} />返回音乐库</button><div><button className="button outline" disabled={!current} onClick={() => setModal('online')}><Globe2 size={15} />联网补全</button>{desktopState && <button className={`button outline ${desktopState.visible ? 'enabled' : ''}`} aria-pressed={desktopState.visible} onClick={() => void window.tingyuDesktop?.setVisible(!desktopState.visible).catch(() => notify('桌面歌词无法打开。'))}><Monitor size={15} />桌面歌词{desktopState.visible ? '已开启' : ''}</button>}{desktopState?.visible && <button className="icon-button" aria-label={desktopState.locked ? '解锁桌面歌词' : '锁定桌面歌词'} onClick={() => void window.tingyuDesktop?.setLocked(!desktopState.locked)}>{desktopState.locked ? <Unlock size={15} /> : <Lock size={15} />}</button>}</div></div>
      <div className="full-lyrics-layout"><div className="full-art"><Artwork track={current} /><h2>{current?.title ?? '让音乐陪你一会儿'}</h2><p>{current?.artist ?? '弦栖霁'}</p><button className={`button outline ${showTranslation ? 'enabled' : ''}`} aria-pressed={showTranslation} onClick={() => setShowTranslation(!showTranslation)}>{showTranslation ? <Check size={16} /> : <Music2 size={16} />}中文译文{showTranslation ? '已开启' : '已关闭'}</button><small className="lyric-source">{[current?.lyricsSource, current?.translationSource].filter(Boolean).join(' · ')}</small>{!!current?.lyrics.length && <small className="lyric-source">{current.lyrics.some((line) => timedWords(line)) ? '逐字歌词按演唱时间高亮；未带逐字时间的行按整句显示。' : current.lyrics.some((line) => line.time >= 0) ? '当前为逐句歌词。精确跟唱请单独导入逐字 LRC / YRC。' : '当前为纯文本歌词，没有演唱时间轴。'}</small>}</div>{renderLyrics(true)}</div>
      <div className="detail-player"><div className="detail-progress"><span>{formatTime(position)}</span><input aria-label="详情播放进度" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(position, duration || 1)} disabled={!current || !duration} style={{ '--progress': `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} onChange={(event) => seek(Number(event.target.value))} /><span>{formatTime(duration)}</span></div><div className="full-playback"><button className="icon-button mode-button" aria-label={`详情播放模式：${modeLabels[mode]}，点击切换`} title={modeLabels[mode]} onClick={() => setMode(nextMode)}>{mode === 'shuffle' ? <Shuffle size={18} /> : mode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}</button><button className="icon-button" aria-label="上一首" disabled={!tracks.length} onClick={() => stepTrack(-1)}><SkipBack size={22} /></button><button className="play-main" aria-label={playing ? '暂停' : '播放'} onClick={togglePlay}>{playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><button className="icon-button" aria-label="下一首" disabled={!tracks.length} onClick={() => stepTrack(1)}><SkipForward size={22} /></button></div></div>
    </div>}

    {modal && ['import', 'settings', 'queue'].includes(modal) && <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) setModal(null); }}><section className={`modal ${modal === 'queue' ? 'queue-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><div><span className="eyebrow">{modal === 'import' ? 'BRING YOUR MUSIC HOME' : modal === 'settings' ? 'MAKE YOURSELF AT HOME' : 'UP NEXT'}</span><h2 id="modal-title">{modal === 'import' ? '让音乐，在这里相遇' : modal === 'settings' ? '偏好设置' : '播放队列'}</h2></div><button className="icon-button" disabled={!!busy} onClick={() => setModal(null)} aria-label="关闭弹窗"><X size={20} /></button></div>
      {modal === 'import' && <><button className="upload-zone" disabled={!!busy} onClick={() => inputRef.current?.click()}>{busy ? <LoaderCircle size={34} className="spin" /> : <FolderInput size={36} />}<strong>{busy || '点击选择，或把音乐包拖到这里'}</strong><span>ZIP 压缩包 / 多选音频与歌词文件</span><small>支持 MP3 · FLAC · WAV · M4A · AAC · OGG · OPUS</small></button>{busy && <button className="button outline" onClick={() => importController.current?.abort()}>暂停并保存进度</button>}<div className="import-separate-actions"><button className="button outline" disabled={!!busy} onClick={() => audioInputRef.current?.click()}><Music2 size={16} />单独导入音频</button><button className="button outline" disabled={!!busy || !tracks.length} onClick={() => lyricInputRef.current?.click()}><ListMusic size={16} />单独导入歌词</button></div><div className="import-help"><h3><Info size={16} />你的音乐包可以长这样</h3><pre>{`我的音乐.zip\n├── 歌手 - 歌曲.mp3\n├── 歌手 - 歌曲.lrc       原文歌词\n├── 歌手 - 歌曲.zh.lrc    中文译文（可选）\n└── cover.jpg            专辑封面（可选）`}</pre><p>文件可放在子文件夹中。同名文件会自动匹配；同一 LRC 的相同时间戳可分别写原文与中文。TXT 支持阅读，无法同步定位。弦栖霁导出的 ZIP 还会恢复收藏与歌词来源。</p><p>缺少歌词或译文时，可在歌曲详情点「联网补全」。不设音乐包总大小上限；仍受设备空间与单首解码能力限制。每首完成即保存，暂停后重选原包继续；未完成的单首歌曲会重新读取。</p></div><button className="text-button demo-link" disabled={!!busy} onClick={() => void loadDemo()}><Headphones size={16} />还没有音乐包？加载原创合成音乐示例<ArrowRight size={15} /></button></>}
      {modal === 'settings' && <div className="settings-content"><UpdateSettings blocked={!!busy || !!storageProgress || !!nativeProgress || alignmentBusy} /><div className="setting-row"><div><strong>显示中文译文</strong><p>有译文的歌曲，将在原文下方显示中文</p></div><button className={`switch ${showTranslation ? 'on' : ''}`} role="switch" aria-checked={showTranslation} aria-label="显示中文译文" onClick={() => setShowTranslation(!showTranslation)}><span /></button></div><div className="setting-row"><div><strong>本地音乐库</strong><p>{storedTracks.length} 首本地歌曲 · {storageInfo}</p></div><button className="button outline" disabled={!storedTracks.length} onClick={() => setModal('export')}><Download size={14} />导出音乐包</button></div><div className="setting-row"><div><strong>四季氛围</strong><p>自动按本机月份切换，可手动选择或关闭</p></div><select aria-label="四季氛围" value={season} onChange={(event) => setSeason(event.target.value as SeasonChoice)}>{Object.entries(seasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="setting-row"><div><strong>断点恢复</strong><p>查看中断任务，导入需重选原包</p></div><button className="button outline" onClick={() => setModal('transfers')}>传输任务</button></div><OnlineSourceSettings auto={sourceAuto} tracks={storedTracks} blocked={!!busy || !!storageProgress || !!nativeProgress || cloud.caching || alignmentBusy} onChanged={async () => { setTracks(await getTracks()); setReady(true); }} /><StorageSettings blocked={!!busy || !!storageProgress || !!nativeProgress || sourceAuto.state.running || cloud.caching || alignmentBusy} trackCount={storedTracks.length} onError={notify} onExport={() => setModal('export')} onChanged={async () => { setTracks(await getTracks()); setReady(true); }} /><CloseSettings onError={notify} /><SleepSettings timer={sleepTimer} now={now} onStart={(minutes, behavior) => { const timer = { deadline: Date.now() + minutes * 60000, behavior, pending: false }; sleepRef.current = timer; if (nativeActiveRef.current) nativeSleepCommand.current = timer.deadline; setSleepTimer(timer); setNow(Date.now()); notify('睡眠定时已开始。'); }} onCancel={clearSleep} /><section className="fade-settings"><h3>播放淡入淡出</h3><label>过渡时长<select aria-label="淡入淡出时长" value={fadeDuration} onChange={(event) => setFadeDuration(Number(event.target.value))}><option value={0}>关闭</option><option value={300}>轻柔 · 0.3 秒</option><option value={500}>标准 · 0.5 秒</option><option value={1000}>舒缓 · 1 秒</option><option value={2000}>缓慢 · 2 秒</option></select></label><p className="field-help">播放时淡入、暂停时淡出；快速切换可中断过渡，音量设置不变。睡眠的立即停止不等待淡出。</p></section><ShortcutSettings /><AISettings config={aiConfig} onSave={saveAIConfig} alignment={automaticAlignment} /><DesktopSettings state={desktopState} onError={notify} /><div className="setting-note"><h3>关于歌词与译文</h3><p>本地歌词优先，可在详情页联网查找 LRCLIB 歌词，核对版本后保存。AI 译文按原文行号匹配，已有译文不重复翻译。下载与翻译结果保存在本机，支持离线阅读与 ZIP 导出。</p><h3>键盘快捷键</h3><p>空格：播放 / 暂停　← / →：后退 / 前进 5 秒　Esc：关闭普通弹窗；联网和导出时请使用窗口内的取消与关闭。</p><h3>储存与设备</h3><p>Windows 默认将全部数据保存在安装目录的 Data 文件夹，音乐库路径可查看和单独更换，歌词译文自动落盘。安卓可在“音乐库保存路径”查看地址，将内部曲库复制到自选目录，或直接打开已有文件音乐库；自选公共目录在卸载后保留，重装需重新授权，内部库仍需导出备份；两端可互相导入，并可连接私人在线曲库自动核对和上传；安卓需保持前台。安卓首次准备完成后使用原生前台播放服务接管队列，支持锁屏切歌与原生睡眠停止；请允许播放通知，部分厂商还需要取消电池限制。</p></div><div className="about-line"><span className="brand-symbol"><Headphones size={20} /></span><div><strong>弦栖霁</strong><small>v{appVersion} · 正式版 · 给音乐留一座岛</small></div><span>OFFLINE FIRST</span></div></div>}
      {modal === 'queue' && <div className="queue-list">{(queue.length ? queue.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track)) : tracks).map((track, index) => <button key={track.id} className={`queue-row ${track.id === currentId ? 'active' : ''}`} onClick={() => playTrack(track)}><span>{String(index + 1).padStart(2, '0')}</span><Artwork track={track} /><span><strong>{track.title}</strong><small>{track.artist}</small></span>{track.id === currentId ? <Disc3 size={18} /> : <Play size={16} />}</button>)}{!tracks.length && <div className="empty-state"><ListMusic size={30} /><p>导入音乐后，下一首惊喜就在这里。</p></div>}</div>}
    </section></div>}
    {modal === 'lyrics' && <LyricImportDialog files={lyricFiles} tracks={tracks} onSave={async (id, patch) => { if (!await updateTrack(id, patch)) throw new Error('歌词保存失败，请检查歌曲和存储空间。'); }} onClose={() => setModal(null)} />}
    {modal === 'online' && current && <OnlineLyricsDialog key={current.id} track={current} aiConfig={aiConfig} onSave={async (patch) => { if (!await updateTrack(current.id, patch)) throw new Error('歌词保存失败，请检查歌曲和存储空间。'); }} onClose={() => setModal(null)} onConfigure={() => { setFullLyrics(false); setModal('settings'); }} />}
    {modal === 'export' && <ExportDialog tracks={storedTracks} currentId={currentId} onClose={() => setModal(null)} onTasks={() => setModal('transfers')} />}
    {modal === 'transfers' && <TransferCenter onClose={() => setModal(null)} onResumeImport={(task, files) => void handleImport(files, task)} />}
    {dragging && <div className="drop-overlay"><FolderInput size={60} /><h2>松手，让音乐住进来</h2><p>歌曲、歌词、封面，一起带来就好。</p></div>}
    {message && <div className="toast" role="status"><Info size={18} /><span>{message}</span><button className="icon-button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={16} /></button></div>}
  </div>;
}
