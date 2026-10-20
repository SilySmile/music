export type PlaybackMode = 'list' | 'shuffle' | 'one';
export const modeLabels: Record<PlaybackMode, string> = { list: '列表循环', shuffle: '随机播放', one: '单曲循环' };
export function nextMode(mode: PlaybackMode): PlaybackMode { return mode === 'list' ? 'shuffle' : mode === 'shuffle' ? 'one' : 'list'; }
export type ShuffleResult = { id: string | undefined; bag: string[] };

/**
 * Shuffle without repeats inside one cycle: the bag holds the songs still to play,
 * is refilled only after it is empty, and never contains the song playing now.
 */
export function nextShuffleTrack(ids: string[], currentId: string, bag: string[], random = Math.random): ShuffleResult {
  if (!ids.length) return { id: undefined, bag: [] };
  if (ids.length === 1) return { id: ids[0], bag: [] };
  let remaining = bag.filter((identifier) => identifier !== currentId && ids.includes(identifier));
  if (!remaining.length) {
    remaining = ids.filter((identifier) => identifier !== currentId);
    for (let index = remaining.length - 1; index > 0; index -= 1) {
      const swap = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))));
      [remaining[index], remaining[swap]] = [remaining[swap], remaining[index]];
    }
  }
  return { id: remaining[0], bag: remaining.slice(1) };
}

export function nextTrackId(ids: string[], currentId: string, direction: number, mode: PlaybackMode, ended = false, random = Math.random) {
  if (!ids.length) return undefined;
  const index = ids.indexOf(currentId);
  if (ended && mode === 'one' && index >= 0) return currentId;
  if (mode === 'shuffle' && ids.length > 1) {
    const choices = ids.filter((identifier) => identifier !== currentId);
    return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
  }
  return ids[((index < 0 ? direction > 0 ? -1 : 0 : index) + direction + ids.length) % ids.length];
}

export function createAudioFader(audio: HTMLAudioElement, getVolume: () => number, getDuration: () => number) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let revision = 0;
  let gain = 1;
  let wantedPlaying = !audio.paused;
  const apply = () => { audio.volume = Math.max(0, Math.min(1, getVolume() * gain)); };
  function cancel() { revision++; clearInterval(timer); timer = undefined; }
  function ramp(target: number, finished?: () => void) {
    clearInterval(timer);
    const duration = getDuration(); const start = performance.now(); const initial = gain;
    if (duration <= 0) { gain = target; apply(); finished?.(); return; }
    timer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - start) / duration);
      gain = initial + (target - initial) * (progress * progress * (3 - 2 * progress)); apply();
      if (progress >= 1) { clearInterval(timer); timer = undefined; finished?.(); }
    }, 16);
  }
  return {
    async play() {
      const wasPaused = audio.paused; cancel(); const request = revision; wantedPlaying = true;
      if (wasPaused) gain = getDuration() > 0 ? 0 : 1;
      apply();
      try { await audio.play(); if (request === revision) ramp(1); }
      catch (error) { if (request === revision) { wantedPlaying = false; gain = 1; apply(); throw error; } }
    },
    pause(immediate = false) {
      cancel(); wantedPlaying = false;
      if (immediate || audio.paused) { audio.pause(); gain = 1; apply(); }
      else ramp(0, () => { audio.pause(); gain = 1; apply(); });
    },
    reset() { cancel(); wantedPlaying = false; gain = 1; apply(); },
    setVolume: apply,
    isPlaying: () => wantedPlaying && !audio.ended,
    dispose: cancel,
  };
}
