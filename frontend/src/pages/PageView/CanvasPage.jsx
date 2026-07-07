import { useEffect, useMemo, useRef, useState } from 'react';
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

// Draws the ruled/squared pattern directly with the Canvas 2D API instead
// of a CSS repeating-gradient background-image scaled via background-size
// (see the note on resizePatternCanvas below for why this canvas is sized to
// the *container*, not the page, which is what makes this cheap to redraw on
// every pan/zoom frame). Both should scale identically in theory, but a
// CSS-gradient-based pattern gave repeated real-device reports of lines
// shifting/multiplying while zooming that couldn't be reproduced or
// root-caused across several rounds of testing (measuring computed
// background-size against page size showed mathematically exact scaling
// every time, on every zoom path tried) — so rather than keep chasing a
// hypothetical browser-specific rendering quirk, this removes the whole
// class of uncertainty: every line is drawn at an explicit, computed pixel
// position, with no scaling/interpolation step for the renderer to get
// wrong. `pageLeft/pageTop/pageWidth/pageHeight` are in the canvas's own
// (container-relative) coordinates, i.e. the page's on-screen rect.
function redrawPatternCanvas(canvas, pageLeft, pageTop, pageWidth, pageHeight, cellPx, pageStyle) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  if (pageStyle === 'empty' || cellPx <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(pageLeft, pageTop, pageWidth, pageHeight);
  ctx.clip();
  ctx.strokeStyle = pageStyle === 'squared' ? '#e2e8f0' : '#d6e4f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = cellPx; y < pageHeight; y += cellPx) {
    const py = Math.round(pageTop + y) + 0.5;
    ctx.moveTo(pageLeft, py);
    ctx.lineTo(pageLeft + pageWidth, py);
  }
  if (pageStyle === 'squared') {
    for (let x = cellPx; x < pageWidth; x += cellPx) {
      const px = Math.round(pageLeft + x) + 0.5;
      ctx.moveTo(px, pageTop);
      ctx.lineTo(px, pageTop + pageHeight);
    }
  }
  ctx.stroke();
  ctx.restore();
}

// Standard ray-casting point-in-polygon test, used by the lasso tool to
// decide which elements fall inside the freeform loop the user drew — an
// element counts as "inside" if its own center point is.
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
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
  // Custom freeform selection tool — Excalidraw only ships rectangular
  // marquee selection natively. While active, Excalidraw's own tool is
  // forced to "selection" (so the group box/resize handles it draws for
  // whatever we select work normally), and we capture the drag ourselves
  // to draw the loop and compute the selection instead of letting
  // Excalidraw's own marquee-select run.
  const [lassoMode, setLassoMode] = useState(false);
  const excalidrawAPIRef = useRef(null);
  const containerRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const pageRef = useRef(null);
  const patternCanvasRef = useRef(null);
  const drawing = useRef(null); // { pointerId, points: [{x,y,clientX,clientY,pressure}], color, size }
  const lassoDrawing = useRef(null); // { pointerId, points: [{x,y,clientX,clientY}] }
  const touchPoints = useRef(new Map()); // pointerId -> {x, y}, all currently-active touches
  const touchTrack = useRef(null); // { pointerId, startClientX, startClientY } — tracks a lone finger for tap detection
  const pinchTrack = useRef(null); // { startDist, startMidX, startMidY, startZoom, startScrollX, startScrollY }
  const pinchRAF = useRef(null); // requestAnimationFrame handle, coalesces pinch updates to once per frame
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
    const canvas = patternCanvasRef.current;
    if (!el) return;
    const dims = PAGE_SIZES[pageSize] || PAGE_SIZES.A5;
    const pageLeft = scrollX * zoomValue;
    const pageTop = scrollY * zoomValue;
    const pageWidth = dims.width * zoomValue;
    const pageHeight = dims.height * zoomValue;
    el.style.left = `${pageLeft}px`;
    el.style.top = `${pageTop}px`;
    el.style.width = `${pageWidth}px`;
    el.style.height = `${pageHeight}px`;
    // The pattern canvas is sized to the *container* (see resizePatternCanvas),
    // not the page, so this is a cheap clear-and-redraw of a few dozen lines —
    // never a canvas.width/height reallocation, which is what was making
    // continuous pinch/pan gestures janky (resizing a canvas's backing store
    // on every pointermove, at page dimensions that can reach several
    // thousand px at high zoom, is drastically more expensive than redrawing
    // within a fixed-size buffer).
    if (canvas) redrawPatternCanvas(canvas, pageLeft, pageTop, pageWidth, pageHeight, CELL_SIZE * zoomValue, pageStyle);
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

  // Picking any tool other than selection (pen, eraser, a shape, ...) means
  // the user is done lassoing — leaving lassoMode on while e.g. freedraw is
  // active would be confusing, since freedraw's own pen capture already
  // takes priority.
  useEffect(() => {
    if (activeToolType !== 'selection') setLassoMode(false);
  }, [activeToolType]);

  function toggleLasso() {
    setLassoMode((prev) => {
      const next = !prev;
      if (next) excalidrawAPIRef.current?.setActiveTool({ type: 'selection' });
      return next;
    });
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

  // Sized to the container (like the overlay above), not to the page —
  // this only needs reallocating when the container itself actually
  // resizes, never on every pan/zoom frame. That's the whole point: a
  // canvas.width/height reassignment fully clears and reallocates its
  // backing store, which at page dimensions reaching several thousand px
  // at high zoom is expensive enough to visibly stutter a continuous pinch
  // gesture if done on every pointermove. Redrawing within an
  // already-sized buffer (see redrawPatternCanvas) is just a clear + a few
  // dozen line draws, regardless of zoom level.
  function resizePatternCanvas() {
    const canvas = patternCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function redrawOverlay() {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (drawing.current && drawing.current.points.length >= 2) {
      const path = strokeToPath2D(
        drawing.current.points.map((p) => [p.x, p.y, p.pressure]),
        { ...STROKE_OPTIONS, size: drawing.current.size }
      );
      ctx.fillStyle = drawing.current.color;
      ctx.fill(path);
      return;
    }
    if (lassoDrawing.current && lassoDrawing.current.points.length >= 2) {
      const pts = lassoDrawing.current.points;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#6965db';
      ctx.fillStyle = 'rgba(105, 101, 219, 0.08)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // The page/lines overlay is only ever resynced in response to Excalidraw's
  // own onScrollChange — but the *container* can also resize on its own
  // (mobile browser chrome hiding/showing as you start interacting with the
  // page, on-screen keyboard, orientation change), independent of any
  // scroll/zoom change. Without this, the page/lines div can end up sized
  // for a stale container rect while Excalidraw's own canvas has already
  // resized to the new one, so they drift apart — this is what watches for
  // that and keeps them locked together no matter what caused the resize.
  function containerRefCallback(el) {
    containerRef.current = el;
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (!el) return;
    requestAnimationFrame(() => {
      resizeOverlay();
      resizePatternCanvas();
      resyncPageToCurrentState();
    });
    resizeObserverRef.current = new ResizeObserver(() => {
      resizeOverlay();
      resizePatternCanvas();
      resyncPageToCurrentState();
    });
    resizeObserverRef.current.observe(el);
  }

  function resyncPageToCurrentState() {
    const api = excalidrawAPIRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!api || !rect || !rect.width || !rect.height) return;
    const appState = api.getAppState();
    const { scrollX, scrollY } = clampScroll(appState.scrollX, appState.scrollY, appState.zoom.value, rect);
    if (scrollX !== appState.scrollX || scrollY !== appState.scrollY) {
      api.updateScene({ appState: { scrollX, scrollY } });
    }
    syncPage(scrollX, scrollY, appState.zoom.value);
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

  // The smallest zoom we ever allow: the page fit to the current viewport.
  // Below that you'd just be looking at gray space around a tiny page, which
  // isn't useful — so both the double-tap-to-fit and the pinch gesture below
  // treat this as a hard floor, not just a default.
  const FIT_MARGIN = 48; // screen px of buffer around the page at fit zoom

  function computeFitZoom(rect) {
    const dims = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.A5;
    return Math.min((rect.width - FIT_MARGIN) / dims.width, (rect.height - FIT_MARGIN) / dims.height);
  }

  // Keeps the page from ever being panned out of view. At exactly fit zoom
  // there's nowhere to go — scroll is pinned to the single centered
  // position (matching "shouldn't be able to move it at all" in fit mode).
  // Above fit zoom, scroll is clamped so the page can never be dragged more
  // than FIT_MARGIN screen px past either edge of the viewport, the same
  // small buffer already visible at fit zoom.
  function clampScroll(scrollX, scrollY, zoomValue, rect) {
    const dims = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.A5;
    const fitZoom = computeFitZoom(rect);
    if (zoomValue <= fitZoom + 1e-6) {
      return {
        scrollX: rect.width / (2 * fitZoom) - dims.width / 2,
        scrollY: rect.height / (2 * fitZoom) - dims.height / 2,
      };
    }
    const clampAxis = (scroll, viewportSize, pageSize) => {
      const minScroll = (viewportSize - FIT_MARGIN) / zoomValue - pageSize;
      const maxScroll = FIT_MARGIN / zoomValue;
      if (minScroll > maxScroll) return viewportSize / (2 * zoomValue) - pageSize / 2; // no room to pan on this axis — stay centered
      return Math.min(Math.max(scroll, minScroll), maxScroll);
    };
    return {
      scrollX: clampAxis(scrollX, rect.width, dims.width),
      scrollY: clampAxis(scrollY, rect.height, dims.height),
    };
  }

  // Capture phase on the page container, all only while Excalidraw's own
  // active tool is "freedraw":
  //  - real pen input, which we turn into a properly pressure-captured
  //    freedraw element (see finalizeStroke).
  //  - touch input, which we handle entirely ourselves rather than letting
  //    Excalidraw's own touch handling run at all: a *lone* finger does
  //    nothing (Excalidraw's own default is to draw with any single
  //    pointer, finger included, when a draw tool is active — not what a
  //    notebook app wants: only the pen should ever leave ink, and a single
  //    finger resting on the page, e.g. the heel of your hand while
  //    writing, shouldn't nudge the view either); two fingers pinch-zoom
  //    and pan together (see updatePinch), with a hard floor at "page fit
  //    to screen" — you can zoom in as far as you like, but never out past
  //    seeing the whole page. A double-tap also fits the page to the
  //    screen (see handleTapForDoubleTap/fitPageToScreen).
  // Everything else — mouse, and pen/touch while any OTHER tool
  // (select/eraser/shapes) is active — is never touched here, so it falls
  // through to Excalidraw natively; that's what gives us a working eraser
  // and select/move for free.
  function handlePointerDownCapture(e) {
    if (lassoMode) {
      if (lassoDrawing.current) return; // already lassoing with another pointer — ignore
      e.stopPropagation();
      e.preventDefault();
      lassoDrawing.current = { pointerId: e.pointerId, points: [getPoint(e)] };
      return;
    }
    if (e.pointerType === 'pen') {
      if (!isPenActive) return;
      e.stopPropagation();
      e.preventDefault();
      drawing.current = { pointerId: e.pointerId, points: [getPoint(e)], color: penColor, size: penSize };
      return;
    }
    if (e.pointerType === 'touch' && isPenActive) {
      e.stopPropagation();
      e.preventDefault();
      touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPoints.current.size === 1) {
        touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY };
        pinchTrack.current = null;
      } else if (touchPoints.current.size === 2) {
        touchTrack.current = null;
        startPinch();
      }
    }
  }

  function startPinch() {
    const api = excalidrawAPIRef.current;
    const appState = api?.getAppState();
    if (!appState) return;
    const [p1, p2] = [...touchPoints.current.values()];
    pinchTrack.current = {
      prevDist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
      prevMidX: (p1.x + p2.x) / 2,
      prevMidY: (p1.y + p2.y) / 2,
      zoom: appState.zoom.value,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
    };
  }

  // Incremental (frame-to-frame), not anchored to the gesture's start: each
  // move computes a delta from the *previous* move rather than from a fixed
  // start snapshot. Real touch input is noisy (a single jittery sample with
  // near-identical finger positions would send an anchored-to-start version
  // of this into a wild zoom swing) — incremental tracking means one bad
  // frame can't throw off the rest of the gesture, since the next good
  // frame just resumes from wherever it actually is.
  function updatePinch() {
    const api = excalidrawAPIRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    const pin = pinchTrack.current;
    if (!api || !rect || !rect.width || !rect.height || !pin) return;
    const [p1, p2] = [...touchPoints.current.values()];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    // Fingers reporting (near-)identical positions for a frame would make
    // the zoom ratio blow up or collapse — skip updating zoom/scroll this
    // frame and just resync the reference point, so the gesture recovers
    // cleanly on the next good frame instead of jumping.
    if (dist < 8 || pin.prevDist < 8) {
      pin.prevDist = dist;
      pin.prevMidX = midX;
      pin.prevMidY = midY;
      return;
    }

    const fitZoom = computeFitZoom(rect);
    const rawZoom = pin.zoom * (dist / pin.prevDist);
    const zoomValue = Math.min(Math.max(rawZoom, fitZoom), 5);

    // Anchor the scene point that was under the PREVIOUS frame's midpoint to
    // the CURRENT midpoint — zooms around where your fingers are, and pans
    // naturally if the midpoint itself drifts (two-finger pan).
    const sceneAnchorX = (pin.prevMidX - rect.left) / pin.zoom - pin.scrollX;
    const sceneAnchorY = (pin.prevMidY - rect.top) / pin.zoom - pin.scrollY;
    const rawScrollX = (midX - rect.left) / zoomValue - sceneAnchorX;
    const rawScrollY = (midY - rect.top) / zoomValue - sceneAnchorY;
    const { scrollX, scrollY } = clampScroll(rawScrollX, rawScrollY, zoomValue, rect);

    api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoomValue } } });
    syncPage(scrollX, scrollY, zoomValue);

    pin.prevDist = dist;
    pin.prevMidX = midX;
    pin.prevMidY = midY;
    pin.zoom = zoomValue;
    pin.scrollX = scrollX;
    pin.scrollY = scrollY;
  }

  function handlePointerMoveCapture(e) {
    if (lassoDrawing.current && e.pointerId === lassoDrawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      lassoDrawing.current.points.push(getPoint(e));
      redrawOverlay();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      drawing.current.points.push(getPoint(e));
      redrawOverlay();
      return;
    }
    if (touchPoints.current.has(e.pointerId)) {
      e.stopPropagation();
      e.preventDefault();
      touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Touch fires pointermove far faster than the display can paint (up
      // to 120Hz+ on some tablets). Coalescing to one updatePinch() per
      // animation frame — using whatever the latest finger positions are by
      // the time that frame runs — keeps the gesture smooth without doing
      // redundant work for intermediate samples that never even get drawn.
      if (touchPoints.current.size === 2 && pinchTrack.current && !pinchRAF.current) {
        pinchRAF.current = requestAnimationFrame(() => {
          pinchRAF.current = null;
          if (touchPoints.current.size === 2 && pinchTrack.current) updatePinch();
        });
      }
      // A lone finger (size 1) does nothing beyond absorbing the input.
    }
  }

  function handlePointerUpCapture(e) {
    if (lassoDrawing.current && e.pointerId === lassoDrawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      finalizeLasso();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      finalizeStroke();
      return;
    }
    if (touchPoints.current.has(e.pointerId)) {
      e.stopPropagation();
      e.preventDefault();
      touchPoints.current.delete(e.pointerId);
      const track = touchTrack.current;
      if (touchPoints.current.size < 2) {
        pinchTrack.current = null;
        if (pinchRAF.current) {
          cancelAnimationFrame(pinchRAF.current);
          pinchRAF.current = null;
        }
      }
      if (track?.pointerId === e.pointerId) {
        touchTrack.current = null;
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
    const zoomValue = computeFitZoom(rect);
    const { scrollX, scrollY } = clampScroll(0, 0, zoomValue, rect);
    api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoomValue } } });
    syncPage(scrollX, scrollY, zoomValue);
  }

  // Converts the drawn freeform loop to scene coordinates and selects every
  // element whose center falls inside it — then leaves Excalidraw's own
  // "selection" tool to take over from there (its usual group box/resize
  // handles/drag-to-move-together UI works on whatever we select here, same
  // as if the user had made a rectangular marquee selection).
  function finalizeLasso() {
    const lasso = lassoDrawing.current;
    lassoDrawing.current = null;
    redrawOverlay();
    if (!lasso || lasso.points.length < 3) return;

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
    const scenePolygon = lasso.points.map((p) => viewportCoordsToSceneCoords({ clientX: p.clientX, clientY: p.clientY }, sceneOpts));

    const selectedElementIds = {};
    for (const el of api.getSceneElements()) {
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      if (pointInPolygon(cx, cy, scenePolygon)) selectedElementIds[el.id] = true;
    }
    api.updateScene({ appState: { selectedElementIds, selectedGroupIds: {} } });
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
        <button
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium shadow-sm ring-1 transition ${
            lassoMode
              ? 'bg-accent text-white ring-accent'
              : 'bg-white text-neutral-700 ring-neutral-200 hover:ring-accent dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700'
          }`}
          onClick={toggleLasso}
        >
          ✂️ {t('canvas.lasso')}
        </button>
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
        style={{ touchAction: isPenActive || lassoMode ? 'none' : 'auto' }}
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
        <canvas ref={patternCanvasRef} className="pointer-events-none absolute inset-0" />
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
