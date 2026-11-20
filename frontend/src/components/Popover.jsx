import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Floating panel anchored to an element, rendered in a portal with fixed
// positioning (so scrollable toolbars can't clip it). Flips above the
// anchor when there's no room below, stays inside the viewport, and closes
// on outside press or Escape.
export default function Popover({ anchorRef, open, onClose, align = 'start', className = '', children }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = panelRef.current;
      if (!a || !p) return;
      const pw = p.offsetWidth;
      const ph = p.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = align === 'end' ? a.right - pw : align === 'center' ? a.left + a.width / 2 - pw / 2 : a.left;
      left = Math.max(8, Math.min(left, vw - pw - 8));
      let top = a.bottom + 6;
      if (top + ph > vh - 8 && a.top - ph - 6 > 8) top = a.top - ph - 6;
      top = Math.max(8, Math.min(top, vh - ph - 8));
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, align]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, zIndex: 1000 }}
      className={`rounded-xl border border-neutral-200 bg-white p-1.5 text-sm text-neutral-800 shadow-xl dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 ${className}`}
    >
      {children}
    </div>,
    document.body
  );
}

export function MenuItem({ icon: Icon, children, onClick, danger, active, disabled, hint }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition disabled:opacity-40 ${
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
          : active
            ? 'bg-accent/15 text-accent-dark dark:text-accent'
            : 'hover:bg-neutral-100 dark:hover:bg-neutral-700/60'
      }`}
    >
      {Icon && <Icon size={16} className="shrink-0 opacity-80" />}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-neutral-400">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-700" />;
}
