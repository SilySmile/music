import type { LyricWord } from '../types';
import { wordProgress } from '../lib/lyricTiming';

export default function TimedLyricText({ text, words, position, active, vertical = false, className = '', lineStart, lineEnd }: { text: string; words?: LyricWord[]; position: number; active: boolean; vertical?: boolean; className?: string; lineStart?: number; lineEnd?: number }) {
  const fallbackProgress = lineStart !== undefined && lineEnd !== undefined && lineStart >= 0 && lineEnd > lineStart ? Math.max(0, Math.min(100, (position - lineStart) / (lineEnd - lineStart) * 100)) : 100;
  return <span className={`timed-lyric-text ${active ? 'timing-active' : ''} ${className}`} data-timing={words ? 'word' : 'line'}>{words ? words.map((word, index) => {
    const progress = active ? wordProgress(word, position, words[index + 1]?.time) : 0;
    return <span className="timed-word" key={index}><span>{word.text}</span>{active && <span className="timed-word-highlight" aria-hidden="true" style={{ clipPath: vertical ? `inset(0 0 ${100 - progress}% 0)` : `inset(0 ${100 - progress}% 0 0)` }}>{word.text}</span>}</span>;
  }) : <span className="timed-line"><span>{text}</span>{active && <span className="timed-word-highlight" aria-hidden="true" style={{ clipPath: vertical ? `inset(0 0 ${100 - fallbackProgress}% 0)` : `inset(0 ${100 - fallbackProgress}% 0 0)` }}>{text}</span>}</span>}</span>;
}
