import { useEffect, useState } from 'react';

export type SeasonChoice = 'auto' | 'spring' | 'summer' | 'autumn' | 'winter' | 'off';
export function seasonForMonth(month: number) { return month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter'; }
export const seasonLabels = { auto: '跟随季节', spring: '春 · 花瓣轻落', summer: '夏 · 萤光微风', autumn: '秋 · 金叶慢舞', winter: '冬 · 雪落无声', off: '关闭动画' };

export default function SeasonAtmosphere({ choice }: { choice: SeasonChoice }) {
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  useEffect(() => { const timer = setInterval(() => setMonth(new Date().getMonth() + 1), 60000); return () => clearInterval(timer); }, []);
  const season = choice === 'auto' ? seasonForMonth(month) : choice;
  useEffect(() => { document.documentElement.dataset.season = season; return () => { delete document.documentElement.dataset.season; }; }, [season]);
  if (season === 'off') return null;
  return <div className={`season-layer season-${season}`} aria-hidden="true">{Array.from({ length: 18 }, (_value, index) => <span className="season-particle" key={index} style={{ '--particle-left': `${(index * 47 + 13) % 100}%`, '--particle-delay': `${-(index * 3.7)}s`, '--particle-duration': `${18 + index % 7 * 3}s`, '--particle-size': `${5 + index % 4 * 2}px`, '--particle-sway': `${40 + index % 5 * 22}px` } as React.CSSProperties} />)}</div>;
}
