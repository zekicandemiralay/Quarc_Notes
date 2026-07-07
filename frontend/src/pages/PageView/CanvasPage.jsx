import { useMemo, useRef, useState } from 'react';
import { Excalidraw, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { isLegacyInkFormat, convertLegacyInk } from '../../lib/inkMigration';
import { strokeToFreedrawElement } from '../../lib/freehandElement';
import { strokeToPath2D, STROKE_OPTIONS } from '../../lib/freehand';

// Dimensions are in scene units (same coordinate space Excalidraw elements
// live in, i.e. CSS px at zoom 1). A CSS px is defined as 1/96in, so these
// are real paper sizes converted at 96dpi (e.g. A5 = 148 x 210mm) — not
// points (1/72in), which is what these were before and rendered the page at
// 72/96 = 75% of true size (visibly closer to A6 than A5). This define an
// actual finite sheet, not just a visual aspect ratio: the page is rendered
// as a sized/positioned rect synced to Excalidraw's own scroll/zoom (see
// syncPage below), so it has real edges instead of tiling infinitely.
const PAGE_SIZES = {
  A5: { width: 559, height: 794, label: 'A5' },
  A4: { width: 794, height: 1123, label: 'A4' },
  Letter: { width: 816, height: 1056, label: 'Letter' },
};

const DEFAULT_SETTINGS = { pageSize: 'A5', pageStyle: 'lined', penSize: 2.5, penColor: '#1f2937' };

const CELL_SIZE = 28; // base spacing (scene px, at zoom 1) for both lined and squared patterns

// Excalidraw's own freedraw renderer computes perfect-freehand's `size` as
// strokeWidth * 4.25 (confirmed by reading its source). Without accounting
// for that, a stroke that looks right in our live preview renders ~4.25x
// thicker the instant it's committed to the scene.
const EXCALIDRAW_FREEDRAW_SIZE_FACTOR = 4.25;

// Double-tap-to-fit thresholds (screen px / ms) for a lone finger.
const TAP_MOVE_TOLERANCE = 10; // max movement for a touch to still count as a "tap" rather than a drag
const DOUBLE_TAP_MS = 350; // max gap between the two taps
const DOUBLE_TAP_DIST = 40; // max distance between the two taps' positions

const PEN_SIZES = [
  { size: 1, dot: 5 },
  { size: 2.5, dot: 8 },
  { size: 5, dot: 12 },
  { size: 9, dot: 16 },
];

const PEN_COLORS = ['#1f2937', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];

// The pattern's own repeating image never changes — only its position/size
// do, and those are driven straight from Excalidraw's scroll/zoom (see
// syncPage below) so the "paper" pans and zooms together with the ink
// instead of sitting on a separate, static layer underneath it.
function patternImage(pageStyle) {
  if (pageStyle === 'lined') {
    return `repeating-linear-gradient(to bottom, transparent, transparent ${CELL_SIZE - 1}px, #d6e4f0 ${CELL_SIZE - 1}px, #d6e4f0 ${CELL_SIZE}px)`;
  }
  if (pageStyle === 'squared') {
    return (
      `repeating-linear-gradient(to bottom, transparent, transparent ${CELL_SIZE - 1}px, #e2e8f0 ${CELL_SIZE - 1}px, #e2e8f0 ${CELL_SIZE}px),` +
      `repeating-linear-gradient(to right, transparent, transparent ${CELL_SIZE - 1}px, #e2e8f0 ${CELL_SIZE - 1}px, #e2e8f0 ${CELL_SIZE}px)`
    );
  }
  return 'none';
}

function patternSize(pageStyle, cellPx) {
  if (pageStyle === 'lined') return `100% ${cellPx}px`;
  if (pageStyle === 'squared') return `${cellPx}px ${cellPx}px, ${cellPx}px ${cellPx}px`;
  return 'auto';
}

export default function CanvasPage({ page, onChange, onSettingsChange }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS, ...(page.canvas_settings || {}) });
  const [showSettings, setShowSettings] = useState(false);
  const [showPenOptions, setShowPenOptions] = useState(false);
  // Mirrors Excalidraw's own active tool. Our reliable pressure-capture path
  // only takes over pen input while Excalidraw's own "freedraw" tool is
  // selected — for every other tool (select/shapes/text/eraser), pen input
  // passes straight through to Excalidraw's native handling untouched. This
  // is what makes the eraser (and select/move) work correctly with a stylus.
  const [activeToolType, setActiveToolType] = useState('freedraw');
  // Pen size/color persist per-page (in canvas_settings, alongside page size
  // and style) so reopening a page picks up the last pen you used on it.
  const [penSize, setPenSizeState] = useState(settings.penSize);
  const [penColor, setPenColorState] = useState(settings.penColor);
  const excalidrawAPIRef = useRef(null);
  const containerRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const pageRef = useRef(null);
  const drawing = useRef(null); // { pointerId, points: [{x,y,clientX,clientY,pressure}], color, size }
  const touchTrack = useRef(null); // { pointerId, startClientX, startClientY } — tracks a lone finger for tap detection
  const activeTouchIds = useRef(new Set());
  const lastTap = useRef(null); // { time, x, y } — for double-tap-to-fit detection
  const saveTimer = useRef(null);

  // Renders the page as an actual finite sheet — sized and positioned in
  // scene coordinates and synced to Excalidraw's own scroll/zoom (via
  // onScrollChange below) — instead of a pattern that fills the whole
  // viewport and tiles infinitely as you pan. The page's own top-left is
  // pinned to scene (0,0), so its on-screen rect is exactly
  // `(scrollX*zoom, scrollY*zoom)` to `((scrollX+width)*zoom, (scrollY+height)*zoom)`
  // — the same screen-coordinate formula Excalidraw itself uses internally.
  // Written straight to the DOM (not React state) since this can fire on
  // every frame of a pan/zoom gesture.
  function syncPage(scrollX, scrollY, zoomValue, pageSize = settings.pageSize, pageStyle = settings.pageStyle) {
    const el = pageRef.current;
    if (!el) return;
    const dims = PAGE_SIZES[pageSize] || PAGE_SIZES.A5;
    const cellPx = CELL_SIZE * zoomValue;
    el.style.left = `${scrollX * zoomValue}px`;
    el.style.top = `${scrollY * zoomValue}px`;
    el.style.width = `${dims.width * zoomValue}px`;
    el.style.height = `${dims.height * zoomValue}px`;
    el.style.backgroundImage = patternImage(pageStyle);
    el.style.backgroundSize = patternSize(pageStyle, cellPx);
    el.style.backgroundPosition = '0 0';
  }

  function handleScrollChange(scrollX, scrollY, zoom) {
    syncPage(scrollX, scrollY, zoom.value);
  }

  const initialData = useMemo(() => {
    const raw = page.ink_json;
    if (isLegacyInkFormat(raw)) {
      const converted = convertLegacyInk(raw);
      // Persist the converted format immediately so we don't reconvert (and
      // don't lose it) on the next load.
      onChange(converted);
      return {
        ...converted,
        appState: { scrollX: 40, scrollY: 40, zoom: { value: 1 }, ...converted.appState, activeTool: { type: 'freedraw' } },
      };
    }
    return {
      elements: raw?.elements || [],
      // Setting activeTool (and the initial scroll/zoom) here — applied
      // through Excalidraw's own initial state restore — is what actually
      // makes them stick reliably. An imperative setActiveTool()/
      // updateScene() call after mount races against Excalidraw's own
      // post-mount setup: confirmed empirically that a post-mount
      // updateScene({appState:{scrollX,scrollY,zoom}}) call is silently
      // reverted (getAppState() still reports the pre-call values seconds
      // later), the same way an imperative setActiveTool() call used to be
      // unreliable for the default tool.
      appState: {
        viewBackgroundColor: 'transparent',
        scrollX: 40,
        scrollY: 40,
        zoom: { value: 1 },
        ...(raw?.appState || {}),
        activeTool: { type: 'freedraw' },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  function scheduleSave() {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = excalidrawAPIRef.current;
      if (!api) return;
      onChange({
        elements: api.getSceneElementsIncludingDeleted(),
        appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
      });
    }, 500);
  }

  function handleExcalidrawChange(_elements, appState) {
    if (appState?.activeTool?.type) setActiveToolType(appState.activeTool.type);
    scheduleSave();
  }

  function handleExcalidrawAPI(api) {
    excalidrawAPIRef.current = api;
    const appState = api.getAppState();
    syncPage(appState.scrollX, appState.scrollY, appState.zoom.value);
  }

  function updateSettings(patch) {
    const next = { ...settings, ...patch };
    setSettings(next);
    onSettingsChange(next);
    const api = excalidrawAPIRef.current;
    if (api) {
      const appState = api.getAppState();
      syncPage(appState.scrollX, appState.scrollY, appState.zoom.value, next.pageSize, next.pageStyle);
    }
  }

  function setPenSize(size) {
    setPenSizeState(size);
    updateSettings({ penSize: size });
  }

  function setPenColor(color) {
    setPenColorState(color);
    updateSettings({ penColor: color });
  }

  function resizeOverlay() {
    const canvas = overlayCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.getContext('2d').scale(dpr, dpr);
  }

  function redrawOverlay() {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (!drawing.current || drawing.current.points.length < 2) return;
    const path = strokeToPath2D(
      drawing.current.points.map((p) => [p.x, p.y, p.pressure]),
      { ...STROKE_OPTIONS, size: drawing.current.size }
    );
    ctx.fillStyle = drawing.current.color;
    ctx.fill(path);
  }

  function containerRefCallback(el) {
    containerRef.current = el;
    if (el) requestAnimationFrame(resizeOverlay);
  }

  function getPoint(e) {
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      clientX: e.clientX,
      clientY: e.clientY,
      pressure: e.pressure,
    };
  }

  const isPenActive = activeToolType === 'freedraw';

  // Capture phase on the page container, all only while Excalidraw's own
  // active tool is "freedraw":
  //  - real pen input, which we turn into a properly pressure-captured
  //    freedraw element (see finalizeStroke).
  //  - a *lone* finger, which does nothing at all — Excalidraw's own
  //    default is to draw with any single pointer, finger included, when a
  //    draw tool is active, and to pan with it when a non-draw tool is
  //    active. Neither is what a notebook app wants: only the pen should
  //    ever leave ink, and a single finger resting on the page (e.g. the
  //    heel of your hand while writing) shouldn't nudge the view either.
  //    Moving the page is a deliberate two-finger gesture, or a double-tap
  //    to fit it to the screen (see handleTapForDoubleTap/fitPageToScreen).
  // The moment a second finger joins, we back off entirely (no
  // stopPropagation for either pointer) and let Excalidraw's native
  // 2-finger pinch-zoom/pan take over untouched. Everything else — mouse,
  // and pen/touch while any OTHER tool (select/eraser/shapes) is active —
  // is never touched here, so it falls through to Excalidraw natively;
  // that's what gives us a working eraser and select/move for free.
  function handlePointerDownCapture(e) {
    if (e.pointerType === 'pen') {
      if (!isPenActive) return;
      e.stopPropagation();
      e.preventDefault();
      drawing.current = { pointerId: e.pointerId, points: [getPoint(e)], color: penColor, size: penSize };
      return;
    }
    if (e.pointerType === 'touch' && isPenActive) {
      activeTouchIds.current.add(e.pointerId);
      if (activeTouchIds.current.size > 1) {
        touchTrack.current = null;
        return;
      }
      // Deliberately NOT stopping propagation here: Excalidraw needs to see
      // every touch's pointerdown to register it for a potential pinch a
      // moment later. If we swallowed it here (like we do for pen), a real
      // 2-finger pinch — where the two touches almost never land in the
      // exact same tick — would only ever hand Excalidraw the *second*
      // finger, and it can't compute a pinch from one registered pointer.
      // We only start actually intercepting from the first *move* onward,
      // once we know this is (still) just the one finger.
      touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY };
    }
  }

  function handlePointerMoveCapture(e) {
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      drawing.current.points.push(getPoint(e));
      redrawOverlay();
      return;
    }
    const track = touchTrack.current;
    if (track && e.pointerId === track.pointerId && activeTouchIds.current.size === 1) {
      // A lone finger does nothing — just absorb the input so Excalidraw's
      // own freedraw tool doesn't draw with it.
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function handlePointerUpCapture(e) {
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      finalizeStroke();
      return;
    }
    if (e.pointerType === 'touch') {
      activeTouchIds.current.delete(e.pointerId);
      const track = touchTrack.current;
      if (track?.pointerId === e.pointerId) {
        touchTrack.current = null;
        // We let this touch's pointerdown through (see handlePointerDownCapture)
        // so Excalidraw could register it in case a pinch followed, then
        // intercepted its moves ourselves once it turned out to be staying
        // lone. Excalidraw's freedraw tool will have started a 1-point
        // element from that pointerdown it never got any points for —
        // swallow the pointerup (so it doesn't try to finalize it) and
        // clean that stray element up.
        e.stopPropagation();
        e.preventDefault();
        cleanupStrayFreedraw();
        handleTapForDoubleTap(e, track);
      }
    }
  }

  // A lone finger doesn't drag the page, but a quick double-tap (two taps,
  // close together in time and position, without much movement in between)
  // fits the page to the screen — same gesture most notebook/PDF apps use.
  function handleTapForDoubleTap(e, track) {
    const moved = Math.hypot(e.clientX - track.startClientX, e.clientY - track.startClientY);
    if (moved > TAP_MOVE_TOLERANCE) {
      lastTap.current = null;
      return;
    }
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_DIST) {
      lastTap.current = null;
      fitPageToScreen();
    } else {
      lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    }
  }

  function fitPageToScreen() {
    const api = excalidrawAPIRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!api || !rect || !rect.width || !rect.height) return;
    const dims = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.A5;
    const margin = 48;
    const zoomValue = Math.min((rect.width - margin) / dims.width, (rect.height - margin) / dims.height, 2);
    const scrollX = rect.width / (2 * zoomValue) - dims.width / 2;
    const scrollY = rect.height / (2 * zoomValue) - dims.height / 2;
    api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoomValue } } });
    syncPage(scrollX, scrollY, zoomValue);
  }

  function cleanupStrayFreedraw() {
    const api = excalidrawAPIRef.current;
    if (!api) return;
    const elements = api.getSceneElementsIncludingDeleted();
    const strayIds = new Set(
      elements.filter((el) => el.type === 'freedraw' && !el.isDeleted && (el.points?.length || 0) < 2).map((el) => el.id)
    );
    if (strayIds.size) {
      api.updateScene({ elements: elements.map((el) => (strayIds.has(el.id) ? { ...el, isDeleted: true } : el)) });
    }
  }

  function finalizeStroke() {
    const stroke = drawing.current;
    drawing.current = null;
    redrawOverlay();
    if (!stroke || stroke.points.length < 2) return;

    const api = excalidrawAPIRef.current;
    if (!api) return;
    const appState = api.getAppState();
    const rect = containerRef.current.getBoundingClientRect();
    const sceneOpts = {
      zoom: appState.zoom,
      offsetLeft: rect.left,
      offsetTop: rect.top,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
    };
    const scenePoints = stroke.points.map((p) => {
      const s = viewportCoordsToSceneCoords({ clientX: p.clientX, clientY: p.clientY }, sceneOpts);
      return { x: s.x, y: s.y, pressure: p.pressure };
    });

    const element = strokeToFreedrawElement({
      points: scenePoints,
      color: stroke.color,
      size: stroke.size / (EXCALIDRAW_FREEDRAW_SIZE_FACTOR * (appState.zoom?.value || 1)),
      simulatePressure: false,
    });

    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element] });
    scheduleSave();
  }

  return (
    <div className="relative flex h-full flex-col bg-neutral-200 dark:bg-neutral-950">
      <div className="flex items-center gap-2 border-b border-neutral-300 bg-gradient-to-r from-amber-50 to-orange-50 p-2.5 dark:border-neutral-700 dark:from-neutral-900 dark:to-neutral-900">
        {isPenActive && (
          <div className="relative">
            <button
              className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm ring-1 ring-neutral-200 transition hover:ring-accent dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700"
              onClick={() => setShowPenOptions((s) => !s)}
            >
              <span className="inline-block h-3.5 w-3.5 rounded-full ring-1 ring-black/10" style={{ backgroundColor: penColor }} />
              {t('canvas.penOptions')}
            </button>
            {showPenOptions && (
              <div className="absolute left-0 top-full z-10 mt-2 w-60 rounded-xl bg-white p-3 shadow-lg ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
                <div className="mb-1.5 text-xs font-medium text-neutral-400">{t('canvas.penSize')}</div>
                <div className="mb-3 flex gap-2">
                  {PEN_SIZES.map((p) => (
                    <button
                      key={p.size}
                      onClick={() => setPenSize(p.size)}
                      className={`flex h-10 flex-1 items-center justify-center rounded-lg transition ${
                        penSize === p.size ? 'bg-accent' : 'bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-700'
                      }`}
                    >
                      <span
                        className="rounded-full"
                        style={{
                          width: p.dot,
                          height: p.dot,
                          backgroundColor: penSize === p.size ? '#fff' : penColor,
                        }}
                      />
                    </button>
                  ))}
                </div>
                <div className="mb-1.5 text-xs font-medium text-neutral-400">{t('canvas.penColor')}</div>
                <div className="flex gap-2">
                  {PEN_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setPenColor(c)}
                      className={`h-7 w-7 rounded-full ring-2 transition ${penColor === c ? 'ring-accent' : 'ring-transparent hover:ring-neutral-300'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="relative">
          <button
            className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm ring-1 ring-neutral-200 transition hover:ring-accent dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700"
            onClick={() => setShowSettings((s) => !s)}
          >
            📄 {t('canvas.pageSettings')}
          </button>
          {showSettings && (
            <div className="absolute left-0 top-full z-10 mt-2 w-60 rounded-xl bg-white p-3 shadow-lg ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-xs font-medium text-neutral-400">{t('canvas.pageSize')}</span>
                <select
                  className="w-full rounded-lg border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-600"
                  value={settings.pageSize}
                  onChange={(e) => updateSettings({ pageSize: e.target.value })}
                >
                  {Object.entries(PAGE_SIZES).map(([key, v]) => (
                    <option key={key} value={key}>{v.label}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-neutral-400">{t('canvas.pageStyle')}</span>
                <select
                  className="w-full rounded-lg border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-600"
                  value={settings.pageStyle}
                  onChange={(e) => updateSettings({ pageStyle: e.target.value })}
                >
                  <option value="lined">{t('canvas.lined')}</option>
                  <option value="squared">{t('canvas.squared')}</option>
                  <option value="empty">{t('canvas.empty')}</option>
                </select>
              </label>
            </div>
          )}
        </div>
      </div>
      <div
        ref={containerRefCallback}
        className={`quarc-canvas-page relative flex-1 overflow-hidden bg-neutral-300 dark:bg-neutral-800 ${isPenActive ? 'quarc-pen-active' : ''}`}
        style={{ touchAction: isPenActive ? 'none' : 'auto' }}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerUpCapture={handlePointerUpCapture}
        onPointerCancelCapture={handlePointerUpCapture}
        onPointerLeave={handlePointerUpCapture}
      >
        <style>{`
          .quarc-canvas-page.quarc-pen-active .App-menu__left { display: none !important; }
          .quarc-canvas-page .excalidraw { --color-primary: #f59e0b; --color-primary-darker: #d97706; --color-primary-darkest: #b45309; --color-primary-light: #fef3c7; --color-primary-light-darker: #fde68a; --color-primary-hover: #d97706; }
        `}</style>
        <div ref={pageRef} className="pointer-events-none absolute bg-white shadow-xl" />
        <Excalidraw
          key={page.id}
          excalidrawAPI={handleExcalidrawAPI}
          initialData={initialData}
          onChange={handleExcalidrawChange}
          onScrollChange={handleScrollChange}
          theme="light"
        />
        <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0" />
      </div>
    </div>
  );
}
