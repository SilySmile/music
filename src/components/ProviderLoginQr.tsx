import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { saveProviderQr } from '../lib/providerLoginUi';

export default function ProviderLoginQr({ image, label, mobile, disabled, expired }: { image?: string; label: string; mobile: boolean; disabled: boolean; expired: boolean }) {
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const available = mobile && !!image && !disabled && !expired;
  const latest = useRef({ available, image }); latest.current = { available, image };
  function cancelPress() { if (press.current) clearTimeout(press.current.timer); press.current = undefined; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelPress(); }; }, []);
  useEffect(() => { cancelPress(); setMessage(''); }, [image, available]);
  useEffect(() => {
    const cancel = () => { if (document.hidden) cancelPress(); };
    document.addEventListener('visibilitychange', cancel);
    window.addEventListener('blur', cancelPress);
    return () => { document.removeEventListener('visibilitychange', cancel); window.removeEventListener('blur', cancelPress); };
  }, []);
  async function save() {
    const current = latest.current;
    if (!current.available || inFlight.current) return;
    inFlight.current = true; setSaving(true); setMessage('正在保存二维码…');
    try { await saveProviderQr(current.image!); if (mounted.current) setMessage('二维码已保存到相册，请打开官方 App 的扫一扫，从相册选择。'); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : '保存失败，请检查相册权限后重试。'); }
    finally { inFlight.current = false; if (mounted.current) setSaving(false); }
  }
  function start(event: PointerEvent<HTMLButtonElement>) {
    cancelPress();
    if (!available || inFlight.current || !event.isPrimary || event.pointerType !== 'touch') return;
    press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(() => { press.current = undefined; void save(); }, 600) };
  }
  const picture = <img src={image} alt={label} draggable={false} className={expired ? 'expired' : ''} />;
  if (!mobile) return picture;
  return <div className="provider-qr-save"><button type="button" className="provider-qr-touch" aria-label={`保存${label}到相册`} disabled={!available || saving}
    onPointerDown={start} onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}
    onPointerMove={(event) => { const current = press.current; if (current && (event.pointerId !== current.id || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10)) cancelPress(); }}
    onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()}
    onClick={(event) => { if (event.detail === 0) void save(); }}>{picture}</button>
    <span className="provider-qr-hint">{expired ? '二维码已过期，请刷新' : '长按二维码保存到相册'}</span>
    {message && <span className="provider-qr-message" role="status">{message}</span>}
  </div>;
}
