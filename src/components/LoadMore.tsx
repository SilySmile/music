import { useEffect, useRef } from 'react';

export default function LoadMore({ enabled, cursor, onLoad, label = '继续上拉加载', retry = false }: { enabled: boolean; cursor: string | number; onLoad(): void; label?: string; retry?: boolean }) {
  const node = useRef<HTMLDivElement>(null);
  const callback = useRef(onLoad); callback.current = onLoad;
  const attempted = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || retry || !node.current || attempted.current === cursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { attempted.current = cursor; observer.disconnect(); callback.current(); }
    }, { root: node.current.closest('.page-scroll, .provider-screen'), rootMargin: '0px 0px 160px 0px' });
    observer.observe(node.current);
    return () => observer.disconnect();
  }, [enabled, cursor, retry]);
  return <div className="load-more" ref={node} role="status"><button className="text-button" disabled={!enabled} onClick={onLoad}>{label}</button></div>;
}
