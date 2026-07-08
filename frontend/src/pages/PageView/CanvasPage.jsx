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

// Standard ray-casting point-in-polygon test.
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

// Standard 2D segment-segment intersection. Returns the intersection point
// plus how far along p1->p2 it falls (t, 0..1), or null if the segments
// don't cross.
function segmentIntersection(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null; // parallel (or degenerate)
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, x: p1.x + t * d1x, y: p1.y + t * d1y };
}

// Literally cuts a polyline (a freedraw stroke's points, in scene
// coordinates, with pressure) at every point it crosses the selection
// polygon's boundary — like Microsoft Paint's selection tool cutting
// through whatever pixels it encloses, rather than treating each stroke as
// an atomic all-or-nothing object. Walks the points, and at each
// inside/outside transition finds every polygon-edge crossing along that
// segment (sorted by how far along it they fall, so a segment that weaves
// through a concave lasso boundary more than once is still handled
// correctly), splitting the stroke there with a linearly-interpolated
// pressure. Returns the resulting inside/outside pieces as arrays of point
// runs — each run becomes its own new freedraw element.
function clipPolylineByPolygon(points, polygon) {
  const insideRuns = [];
  const outsideRuns = [];
  if (points.length === 0) return { insideRuns, outsideRuns };

  let currentInside = pointInPolygon(points[0].x, points[0].y, polygon);
  let currentRun = [points[0]];

  const flush = () => {
    if (currentRun.length > 1) (currentInside ? insideRuns : outsideRuns).push(currentRun);
  };

  for (let i = 1; i < points.length; i++) {
    const p1 = points[i - 1];
    const p2 = points[i];
    const p2Inside = pointInPolygon(p2.x, p2.y, polygon);

    if (p2Inside === currentInside) {
      currentRun.push(p2);
      continue;
    }

    const crossings = [];
    for (let j = 0; j < polygon.length; j++) {
      const a = polygon[j];
      const b = polygon[(j + 1) % polygon.length];
      const hit = segmentIntersection(p1, p2, a, b);
      if (hit) crossings.push(hit);
    }
    crossings.sort((a, b) => a.t - b.t);

    for (const c of crossings) {
      const pressure = p1.pressure + (p2.pressure - p1.pressure) * c.t;
      const boundaryPoint = { x: c.x, y: c.y, pressure };
      currentRun.push(boundaryPoint);
      flush();
      currentInside = !currentInside;
      currentRun = [boundaryPoint];
    }
    currentRun.push(p2);
    // Trust a fresh test on p2 over the crossing-count parity, so a rare
    // numerical edge case in the crossing search can't compound across the
    // rest of the stroke.
    currentInside = p2Inside;
  }
  flush();

  return { insideRuns, outsideRuns };
}

// For non-freedraw elements (shapes, text, ...) that don't make sense to
// literally cut, this decides whether the selection area touches the
// element's bounding box at all — checked three ways: either shape's
// corners inside the other shape, or any of their edges crossing.
function boundingBoxIntersectsPolygon(el, polygon) {
  const minX = el.x;
  const minY = el.y;
  const maxX = el.x + el.width;
  const maxY = el.y + el.height;
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  if (corners.some((c) => pointInPolygon(c.x, c.y, polygon))) return true;
  if (polygon.some((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)) return true;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let j = 0; j < polygon.length; j++) {
      if (segmentIntersection(a, b, polygon[j], polygon[(j + 1) % polygon.length])) return true;
    }
  }
  return false;
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
  // Custom MS-Paint-style selection: 'rect' (dashed marquee) or 'freeform'
  // (dashed lasso loop), or null when neither is active. While one is
  // active, Excalidraw's own tool is forced to "selection" (so the group
  // box/resize handles/drag-together UI it draws for whatever ends up
  // selected work normally), and we capture the drag ourselves to draw the
  // selection region and — unlike Excalidraw's native marquee, which
  // selects whole elements only — literally cut any freedraw stroke that's
  // only partially inside it (see finalizeSelection).
  const [selectionTool, setSelectionTool] = useState(null);
  const excalidrawAPIRef = useRef(null);
  const containerRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const pageRef = useRef(null);
  const patternCanvasRef = useRef(null);
  const drawing = useRef(null); // { pointerId, points: [{x,y,clientX,clientY,pressure}], color, size }
  const selectionDrawing = useRef(null); // { pointerId, mode: 'rect'|'freeform', points: [{x,y,clientX,clientY}] }
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
  // the user is done with the custom selection tool — leaving it on while
  // e.g. freedraw is active would be confusing, since freedraw's own pen
  // capture already takes priority.
  useEffect(() => {
    if (activeToolType !== 'selection') setSelectionTool(null);
  }, [activeToolType]);

  function selectTool(mode) {
    setSelectionTool((prev) => {
      const next = prev === mode ? null : mode;
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
    if (selectionDrawing.current && selectionDrawing.current.points.length >= 2) {
      const sel = selectionDrawing.current;
      const pts = sel.points;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#6965db';
      ctx.fillStyle = 'rgba(105, 101, 219, 0.08)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (sel.mode === 'rect') {
        const p0 = pts[0];
        const p1 = pts[pts.length - 1];
        const x = Math.min(p0.x, p1.x);
        const y = Math.min(p0.y, p1.y);
        ctx.rect(x, y, Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
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

  // Capture phase on the page container:
  //  - real pen input while freedraw is active, which we turn into a
  //    properly pressure-captured freedraw element (see finalizeStroke) —
  //    pen input while any OTHER tool is active falls through to Excalidraw
  //    natively, which is what gives us a working eraser/select for free.
  //  - camera control (two-finger pinch-zoom/pan, with a hard floor at
  //    "page fit to screen", and double-tap-to-fit) works the same
  //    regardless of which tool is active, since navigating the page isn't
  //    a tool-specific gesture — see updatePinch/handleTapForDoubleTap.
  //  - a *lone* finger only gets consumed while freedraw is active (a
  //    notebook app shouldn't draw or pan with a bare finger — only the pen
  //    should leave ink, and a finger resting on the page, e.g. the heel of
  //    your hand while writing, shouldn't nudge the view either). With any
  //    other tool, a lone finger is left alone so touch keeps working
  //    normally for that tool (eraser, select, ...) — except when it looks
  //    like the second tap of a double-tap, which we pre-empt so
  //    Excalidraw's own native double-tap/dblclick zoom doesn't also fire.
  function handlePointerDownCapture(e) {
    if (selectionTool) {
      if (selectionDrawing.current) return; // already selecting with another pointer — ignore
      e.stopPropagation();
      e.preventDefault();
      selectionDrawing.current = { pointerId: e.pointerId, mode: selectionTool, points: [getPoint(e)] };
      return;
    }
    if (e.pointerType === 'pen') {
      if (!isPenActive) return;
      e.stopPropagation();
      e.preventDefault();
      drawing.current = { pointerId: e.pointerId, points: [getPoint(e)], color: penColor, size: penSize };
      return;
    }
    if (e.pointerType === 'touch') {
      touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touchPoints.current.size >= 2) {
        // A second finger always hijacks into our own pinch/pan, no matter
        // which tool is active — camera control isn't a tool-specific
        // gesture. (If the first finger's own down wasn't consumed below
        // because some other tool was active, Excalidraw may have already
        // started its own single-finger action with it; taking over from
        // here is an accepted rough edge for a second finger landing
        // mid-gesture, which is rare in practice.)
        touchTrack.current = null;
        e.stopPropagation();
        e.preventDefault();
        startPinch();
        return;
      }

      if (isPenActive) {
        // A lone finger never draws or pans while writing — consume it
        // entirely (see the block comment above).
        e.stopPropagation();
        e.preventDefault();
        touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, consumed: true };
        pinchTrack.current = null;
        return;
      }

      // Any other tool: only pre-empt this touch if it looks like the
      // second tap of a double-tap (close in time and position to the last
      // recorded tap) — that stops Excalidraw's own native double-tap/
      // dblclick zoom from also firing. Otherwise leave it alone so touch
      // keeps working normally for whatever tool is active (eraser,
      // select, ...); we still track its start position so a genuine tap
      // (not a drag) gets recorded as the "last tap" for next time.
      const now = Date.now();
      const last = lastTap.current;
      const looksLikeSecondTap = !!last && now - last.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_DIST;
      touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, consumed: looksLikeSecondTap };
      pinchTrack.current = null;
      if (looksLikeSecondTap) {
        e.stopPropagation();
        e.preventDefault();
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
    if (selectionDrawing.current && e.pointerId === selectionDrawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      selectionDrawing.current.points.push(getPoint(e));
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
      touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touchPoints.current.size >= 2 && pinchTrack.current) {
        e.stopPropagation();
        e.preventDefault();
        // Touch fires pointermove far faster than the display can paint (up
        // to 120Hz+ on some tablets). Coalescing to one updatePinch() per
        // animation frame — using whatever the latest finger positions are
        // by the time that frame runs — keeps the gesture smooth without
        // doing redundant work for intermediate samples that never even get
        // drawn.
        if (!pinchRAF.current) {
          pinchRAF.current = requestAnimationFrame(() => {
            pinchRAF.current = null;
            if (touchPoints.current.size >= 2 && pinchTrack.current) updatePinch();
          });
        }
        return;
      }

      // A lone finger: consume it only if we're the ones handling its
      // whole lifecycle (writing mode, or it was flagged as a likely
      // second tap at pointerdown) — otherwise this is normal single-finger
      // use of whatever other tool is active, and shouldn't be touched.
      if (touchTrack.current?.pointerId === e.pointerId && touchTrack.current.consumed) {
        e.stopPropagation();
        e.preventDefault();
      }
    }
  }

  function handlePointerUpCapture(e) {
    if (selectionDrawing.current && e.pointerId === selectionDrawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      finalizeSelection();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      finalizeStroke();
      return;
    }
    if (touchPoints.current.has(e.pointerId)) {
      const wasPinching = touchPoints.current.size >= 2 && !!pinchTrack.current;
      const track = touchTrack.current?.pointerId === e.pointerId ? touchTrack.current : null;
      touchPoints.current.delete(e.pointerId);
      if (touchPoints.current.size < 2) {
        pinchTrack.current = null;
        if (pinchRAF.current) {
          cancelAnimationFrame(pinchRAF.current);
          pinchRAF.current = null;
        }
      }
      if (track) {
        touchTrack.current = null;
        if (track.consumed) {
          e.stopPropagation();
          e.preventDefault();
        }
        // Runs regardless of consumed: a genuine tap that fell through to
        // whatever tool is active still needs to be recorded as "last tap"
        // so the NEXT touch can recognize itself as a possible second tap.
        handleTapForDoubleTap(e, track);
        return;
      }
      if (wasPinching) {
        e.stopPropagation();
        e.preventDefault();
      }
      // else: a lone, un-consumed touch ending — let native tool behavior see it.
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

  // MS-Paint-style selection: converts the drawn region (rectangle or
  // freeform loop) to a scene-coordinate polygon, then — for every freedraw
  // stroke only partially inside it — literally cuts the stroke at the
  // boundary via clipPolylineByPolygon, replacing it with separate "inside"
  // (selected) and "outside" (left behind, unselected) pieces. A stroke
  // entirely inside or entirely outside is left as a single piece (just
  // selected, or just untouched). Non-freedraw elements (shapes/text) can't
  // sensibly be "cut", so those are selected whole if the region touches
  // their bounding box at all. Leaves Excalidraw's own "selection" tool to
  // take over from there — its usual group box/resize handles/drag-
  // together UI works on whatever ends up selected here exactly as if the
  // user had made a native marquee selection.
  function finalizeSelection() {
    const sel = selectionDrawing.current;
    selectionDrawing.current = null;
    redrawOverlay();
    if (!sel) return;

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
    const toScene = (p) => viewportCoordsToSceneCoords({ clientX: p.clientX, clientY: p.clientY }, sceneOpts);

    let polygon;
    if (sel.mode === 'rect') {
      const a = toScene(sel.points[0]);
      const b = toScene(sel.points[sel.points.length - 1]);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      if (maxX - minX < 3 || maxY - minY < 3) return; // too small — an accidental tap, not a drag
      polygon = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
    } else {
      if (sel.points.length < 3) return;
      polygon = sel.points.map(toScene);
      const xs = polygon.map((p) => p.x);
      const ys = polygon.map((p) => p.y);
      if (Math.max(...xs) - Math.min(...xs) < 3 || Math.max(...ys) - Math.min(...ys) < 3) return;
    }

    const elements = api.getSceneElementsIncludingDeleted();
    const newElements = [];
    const selectedElementIds = {};

    for (const el of elements) {
      if (el.isDeleted) {
        newElements.push(el);
        continue;
      }
      if (el.type === 'freedraw') {
        const absPoints = el.points.map((p, i) => ({
          x: el.x + p[0],
          y: el.y + p[1],
          pressure: el.pressures?.[i] ?? 0.5,
        }));
        const { insideRuns, outsideRuns } = clipPolylineByPolygon(absPoints, polygon);
        if (insideRuns.length === 0) {
          newElements.push(el); // untouched — none of it is in the selection
          continue;
        }
        if (outsideRuns.length === 0) {
          // Entirely inside — keep the original element (preserves its id/
          // history) rather than rebuilding identical geometry, just select it.
          newElements.push(el);
          selectedElementIds[el.id] = true;
          continue;
        }
        for (const run of outsideRuns) {
          if (run.length < 2) continue;
          newElements.push(
            strokeToFreedrawElement({ points: run, color: el.strokeColor, size: el.strokeWidth, simulatePressure: el.simulatePressure })
          );
        }
        for (const run of insideRuns) {
          if (run.length < 2) continue;
          const piece = strokeToFreedrawElement({ points: run, color: el.strokeColor, size: el.strokeWidth, simulatePressure: el.simulatePressure });
          newElements.push(piece);
          selectedElementIds[piece.id] = true;
        }
      } else {
        newElements.push(el);
        if (boundingBoxIntersectsPolygon(el, polygon)) selectedElementIds[el.id] = true;
      }
    }

    api.updateScene({ elements: newElements, appState: { selectedElementIds, selectedGroupIds: {} } });
    scheduleSave();

    // Immediately hand off to Excalidraw's own plain "selection" tool
    // (move/resize) rather than staying in draw-a-selection-region mode —
    // otherwise the very next drag, meant to move what was just selected,
    // would be reinterpreted by us as drawing *another* selection region
    // and cut it again. This is also just how the gesture should feel:
    // select, then immediately drag to move — not select, then re-arm a
    // tool button before you can move anything.
    setSelectionTool(null);
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
            selectionTool === 'rect'
              ? 'bg-accent text-white ring-accent'
              : 'bg-white text-neutral-700 ring-neutral-200 hover:ring-accent dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700'
          }`}
          onClick={() => selectTool('rect')}
        >
          ▭ {t('canvas.rectSelect')}
        </button>
        <button
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium shadow-sm ring-1 transition ${
            selectionTool === 'freeform'
              ? 'bg-accent text-white ring-accent'
              : 'bg-white text-neutral-700 ring-neutral-200 hover:ring-accent dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700'
          }`}
          onClick={() => selectTool('freeform')}
        >
          ✂️ {t('canvas.freeSelect')}
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
        style={{
          touchAction: isPenActive || selectionTool ? 'none' : 'auto',
          cursor: selectionTool ? 'crosshair' : undefined,
        }}
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
