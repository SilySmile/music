import type { LyricWord } from '../types';
import { wordProgress } from '../lib/lyricTiming';

export default function TimedLyricText({ text, words, position, active, vertical = false, className = '' }: { text: string; words?: LyricWord[]; position: number; active: boolean; vertical?: boolean; className?: string }) {
  return <span className={`timed-lyric-text ${active ? 'timing-active' : ''} ${className}`} data-timing={words ? 'word' : 'line'}>{words ? words.map((word, index) => {
    const progress = active ? wordProgress(word, position, words[index + 1]?.time) : 0;
    return <span className="timed-word" key={index}><span>{word.text}</span>{active && <span className="timed-word-highlight" aria-hidden="true" style={{ clipPath: vertical ? `inset(0 0 ${100 - progress}% 0)` : `inset(0 ${100 - progress}% 0 0)` }}>{word.text}</span>}</span>;
  }) : text}</span>;
}
