import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hexToHsv, hsvToHex, normalizeHex } from '../lib/color';

// A colour wheel: angle is the hue, distance from the centre the saturation;
// the bar underneath sets the brightness. Plus a hex field and the colours
// used recently. Dragging only updates the preview — the colour is handed to
// `onPick` when the finger/pen lifts (or a hex is entered or a recent colour
// tapped), so a drag doesn't rewrite the page's settings on every move.
//
//   color      current colour, "#rrggbb"
//   onPick     (hex) => void — a colour was chosen
//   recent     recently used colours, newest first
//   onClear    clears that history
//   inkFilter  CSS filter that makes a swatch look like the ink does on the
//              (dark) paper — only for the swatches, never for the wheel

const WHEEL = 200;

function useDrag(onMove, onEnd) {
  // Pointer-capture drag that works the same for mouse, touch and pen.
  return {
    onPointerDown: (e) => {
      if (e.button !== undefined && e.button > 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.currentTarget.dataset.dragging = '1';
      onMove(e);
    },
    onPointerMove: (e) => {
      if (e.currentTarget.dataset.dragging) onMove(e);
    },
    onPointerUp: (e) => {
      if (!e.currentTarget.dataset.dragging) return;
      delete e.currentTarget.dataset.dragging;
      onEnd();
    },
    onPointerCancel: (e) => {
      if (!e.currentTarget.dataset.dragging) return;
      delete e.currentTarget.dataset.dragging;
      onEnd();
    },
  };
}

export default function ColorPicker({ color, onPick, recent = [], onClear, inkFilter }) {
  const { t } = useTranslation();
  const [hsv, setHsv] = useState(() => hexToHsv(color));
  const hsvRef = useRef(hsv);
  const [hex, setHex] = useState(color);
  const [hexBad, setHexBad] = useState(false);
  const wheelRef = useRef(null);
  const barRef = useRef(null);
  // The pen's default colour is a dark slate: tapping the wheel should give
  // that hue vividly, not a near-black. Brightness is only kept when it was
  // set on purpose (the bar, a hex, a recent colour) in this picker.
  const brightnessChosen = useRef(false);

  const set = (next) => {
    hsvRef.current = next;
    setHsv(next);
    setHex(hsvToHex(next.h, next.s, next.v));
    setHexBad(false);
  };

  // Follow a colour chosen elsewhere (a swatch, another picker), but keep the
  // hue when the colour has none (white, greys, black) so dragging the
  // brightness bar back up doesn't jump to red.
  useEffect(() => {
    const cur = hsvToHex(hsvRef.current.h, hsvRef.current.s, hsvRef.current.v);
    const n = normalizeHex(color);
    if (n && n !== cur) {
      const next = hexToHsv(n);
      set({ h: next.s && next.v ? next.h : hsvRef.current.h, s: next.s, v: next.v });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  const commit = () => onPick(hsvToHex(hsvRef.current.h, hsvRef.current.s, hsvRef.current.v));

  const wheelDrag = useDrag((e) => {
    const r = wheelRef.current.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    let h = (Math.atan2(x, -y) * 180) / Math.PI;
    if (h < 0) h += 360;
    const v = brightnessChosen.current ? hsvRef.current.v || 1 : 1;
    brightnessChosen.current = true;
    set({ h, s: Math.min(1, Math.hypot(x, y) / (r.width / 2)), v });
  }, commit);

  const barDrag = useDrag((e) => {
    const r = barRef.current.getBoundingClientRect();
    brightnessChosen.current = true;
    set({ ...hsvRef.current, v: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) });
  }, commit);

  function submitHex() {
    const n = normalizeHex(hex);
    if (!n) {
      setHexBad(true);
      return;
    }
    brightnessChosen.current = true;
    set(hexToHsv(n));
    onPick(n);
  }

  const now = hsvToHex(hsv.h, hsv.s, hsv.v);
  const rad = (hsv.h * Math.PI) / 180;

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={wheelRef}
        role="img"
        aria-label={t('canvas.colorWheel')}
        {...wheelDrag}
        className="relative mx-auto shrink-0 cursor-crosshair select-none rounded-full shadow-inner ring-1 ring-black/10"
        style={{ width: WHEEL, height: WHEEL, touchAction: 'none', background: 'conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
      >
        <div className="pointer-events-none absolute inset-0 rounded-full" style={{ background: 'radial-gradient(closest-side, #fff, rgba(255,255,255,0))' }} />
        <span
          className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.3)]"
          style={{ left: `${50 + 50 * hsv.s * Math.sin(rad)}%`, top: `${50 - 50 * hsv.s * Math.cos(rad)}%`, backgroundColor: now }}
        />
      </div>

      <div
        ref={barRef}
        role="img"
        aria-label={t('canvas.brightness')}
        {...barDrag}
        className="relative h-7 cursor-pointer select-none rounded-full ring-1 ring-black/10"
        style={{ touchAction: 'none', background: `linear-gradient(to right, #000, ${hsvToHex(hsv.h, hsv.s, 1)})` }}
      >
        <span
          className="pointer-events-none absolute top-1/2 h-8 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.3)]"
          style={{ left: `${hsv.v * 100}%`, backgroundColor: now }}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="h-9 w-9 shrink-0 rounded-lg ring-1 ring-black/10" style={{ backgroundColor: now, filter: inkFilter }} title={now} />
        <input
          value={hex}
          onChange={(e) => {
            setHex(e.target.value);
            setHexBad(false);
          }}
          onBlur={() => normalizeHex(hex) && normalizeHex(hex) !== now && submitHex()}
          onKeyDown={(e) => e.key === 'Enter' && submitHex()}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={7}
          aria-label="Hex"
          aria-invalid={hexBad}
          className={`min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-sm uppercase outline-none focus:border-accent ${
            hexBad ? 'border-red-500' : 'border-neutral-300 dark:border-neutral-600'
          }`}
        />
      </div>

      {recent.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-neutral-400">
            <span>{t('canvas.recentColors')}</span>
            {onClear && (
              <button type="button" onClick={onClear} className="rounded px-1 hover:text-neutral-600 dark:hover:text-neutral-200">
                {t('canvas.clearHistory')}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2" style={{ filter: inkFilter }}>
            {recent.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                aria-label={c}
                onClick={() => {
                  brightnessChosen.current = true;
                  set(hexToHsv(c));
                  onPick(c);
                }}
                className={`h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-white transition dark:ring-offset-neutral-800 ${
                  c === now ? 'ring-accent' : 'ring-transparent hover:ring-neutral-300'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
