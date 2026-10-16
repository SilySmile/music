import { useEffect, useState } from 'react';
import { Headphones } from 'lucide-react';
export default function StartupScreen({ ready }: { ready: boolean }) {
  const [minimumElapsed, setMinimumElapsed] = useState(false);
  const [closed, setClosed] = useState(false);
  useEffect(() => { const minimum = setTimeout(() => setMinimumElapsed(true), 650); const maximum = setTimeout(() => setClosed(true), 3500); return () => { clearTimeout(minimum); clearTimeout(maximum); }; }, []);
  useEffect(() => { if (ready && minimumElapsed) { const timer = setTimeout(() => setClosed(true), 300); return () => clearTimeout(timer); } }, [ready, minimumElapsed]);
  if (closed) return null;
  return <div className={`startup-screen ${ready && minimumElapsed ? 'leaving' : ''}`} aria-hidden="true"><span className="startup-mark"><Headphones size={45} /></span><h1>弦栖霁</h1><p>让喜欢的音乐，留在身边</p><span className="startup-wave"><i /><i /><i /><i /><i /></span></div>;
}
