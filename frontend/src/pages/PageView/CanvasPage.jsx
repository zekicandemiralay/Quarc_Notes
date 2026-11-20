import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Excalidraw,
  newElementWith,
  CaptureUpdateAction,
  reconcileElements,
  getSceneVersion,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, MoreHorizontal, FilePlus2, Trash2, Plus, ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import { isLegacyInkFormat, convertLegacyInk } from '../../lib/inkMigration';
import { strokeToFreedrawElement } from '../../lib/freehandElement';
import { strokeToPath2D, STROKE_OPTIONS } from '../../lib/freehand';
import { recognizeShape, adjustShape, shapeOutline } from '../../lib/shapeRecognition';
import { db } from '../../lib/db';
import { on } from '../../lib/events';
import useSettings from '../../store/settingsStore';
import Popover, { MenuItem, MenuSeparator } from '../../components/Popover';
import CanvasToolbar from './canvas/CanvasToolbar';
import { clipPolylineByPolygon, boundingBoxIntersectsPolygon, getCuttableOutline, cutOutline, pinCutJoints } from './canvas/selectionCut';
import { shapeToElements, inkWidth, eraserHits, EXCALIDRAW_FREEDRAW_SIZE_FACTOR } from './canvas/elements';
import {
  sheetDims,
  sheetTop,
  docHeight,
  sheetAt,
  sheetsNeeded,
  fitPageZoom,
  fitWidthZoom,
  clampView,
  viewForSheet,
  drawPaper,
  paperColors,
  PAGE_GAP,
  MAX_ZOOM,
} from './canvas/notebook';

const DEFAULT_SETTINGS = {
  pageSize: 'A5',
  pageStyle: 'lined',
  pageCount: 1,
  orientation: 'portrait',
  tool: 'pen',
  penSize: 2.5,
  penColor: '#1f2937',
  hlSize: 14,
  hlColor: '#ffd43b',
};

const HOLD_MS = 500; // keep the pen still this long at a stroke's end to snap it to a shape
const HOLD_RADIUS = { pen: 6, mouse: 5, touch: 10 }; // screen px of jitter that still counts as "still"
const ERASER_RADIUS = 10; // screen px, for the stylus button / eraser end
const PALM_WINDOW_MS = 500; // touches this soon after pen activity are a resting hand
const PALM_SIZE = 60; // touch contact (CSS px) this big is a palm, not a fingertip
const HIGHLIGHTER_OPACITY = 40;
const TAP_MOVE_TOLERANCE = 10;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DIST = 40;
const TWO_FINGER_TAP_MS = 300;
const DELETED_RETENTION_MS = 14 * 24 * 3600 * 1000; // erased strokes are kept this long so offline devices sync the erase
// Excalidraw's dark theme renders the scene through this filter; the live
// preview (and colour swatches) use it too, so ink looks the same while
// being drawn as after.
const DARK_INK_FILTER = 'invert(93%) hue-rotate(180deg)';

const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
    export: false,
    saveAsImage: true,
    clearCanvas: true,
  },
};

// Icons for the custom selection tool button portaled into Excalidraw's own
// toolbar (dashed marquee / dashed lasso, matching Excalidraw's outline icons).
const RectSelectIcon = (
  <svg viewBox="0 0 20 20" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="5" width="13" height="10" rx="1" strokeDasharray="2.5 2.5" />
  </svg>
);
const FreeformSelectIcon = (
  <svg viewBox="0 0 20 20" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 9.7c-.4-3.1 2.6-5.3 5.4-4.9 3.1.5 5.7 2.1 5.4 5.2-.3 2.9-3.1 4.7-5.9 4.6-2.3-.1-4.6-1.9-4.9-4.9z" strokeDasharray="2.5 2.5" />
  </svg>
);
const ChevronDownIcon = (
  <svg viewBox="0 0 10 6" width={10} height={6} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 1l4 4 4-4" />
  </svg>
);

const viewKey = (id) => `quarc_notes_view_${id}`;

function readStoredView(id) {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(id)) || 'null');
    return v && [v.scrollX, v.scrollY, v.zoom].every(Number.isFinite) && v.zoom > 0 ? v : null;
  } catch {
    return null;
  }
}

function isEraserButton(e) {
  return e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || (e.buttons & 2) !== 0 || e.button === 5 || e.button === 2);
}

function pruneDeleted(elements) {
  const cutoff = Date.now() - DELETED_RETENTION_MS;
  return elements.filter((el) => !el.isDeleted || (el.updated || 0) > cutoff);
}

export default function CanvasPage({ page, onChange, onSettingsChange }) {
  const { t, i18n } = useTranslation();
  const isDark = useSettings((s) => s.isDark);
  const paperFollowsTheme = useSettings((s) => s.paperFollowsTheme);
  const fingerMode = useSettings((s) => s.fingerMode);
  const penSeen = useSettings((s) => s.penSeen);
  const shapeSnap = useSettings((s) => s.shapeSnap);
  const updatePrefs = useSettings((s) => s.update);
  const paperDark = isDark && paperFollowsTheme;
  const fingerDraws = fingerMode === 'draw' || (fingerMode === 'auto' && !penSeen);

  const initial = useMemo(() => {
    const raw = page.ink_json;
    const legacy = isLegacyInkFormat(raw);
    const scene = legacy ? convertLegacyInk(raw) : raw || {};
    // Closes the gaps left by cuts made before 1.2.10 (saved with the next edit).
    return { elements: pinCutJoints(scene.elements || []), files: scene.files || {}, legacy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  const [settings, setSettings] = useState(() => {
    const s = { ...DEFAULT_SETTINGS, ...(page.canvas_settings || {}) };
    // Strokes below the last sheet (e.g. from before multi-page notebooks)
    // must stay reachable.
    s.pageCount = Math.max(s.pageCount || 1, sheetsNeeded(initial.elements, sheetDims(s)));
    return s;
  });
  const [activeToolType, setActiveToolType] = useState('freedraw');
  const [currentSheet, setCurrentSheet] = useState(0);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [selectionTool, setSelectionTool] = useState(null);
  const [selectionVariant, setSelectionVariant] = useState('rect');
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [toolbarPortalEl, setToolbarPortalEl] = useState(null);

  const apiRef = useRef(null);
  const containerRef = useRef(null);
  const paperRef = useRef(null);
  const overlayRef = useRef(null);
  const addPageBtnRef = useRef(null);
  const pageMenuBtnRef = useRef(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const gestureRect = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const prefsRef = useRef({});
  prefsRef.current = { fingerDraws, shapeSnap, paperDark };
  const currentSheetRef = useRef(0);

  const drawing = useRef(null); // pen/mouse/finger stroke in progress
  const erasing = useRef(null); // stylus-button erase in progress
  const eraserCursor = useRef(null);
  const selectionDrawing = useRef(null);
  const touchPoints = useRef(new Map());
  const ignoredTouches = useRef(new Set()); // palms
  const touchPan = useRef(null);
  const touchTrack = useRef(null);
  const pinchTrack = useRef(null);
  const pinchRAF = useRef(null);
  const twoFingerTap = useRef(null);
  const lastTap = useRef(null);
  const lastPenActivity = useRef(0);
  const inertiaRAF = useRef(null);
  const overlayRAF = useRef(null);
  const initialViewRAF = useRef(null);

  const saveTimer = useRef(null);
  const viewSaveTimer = useRef(null);
  const savedVersion = useRef(null);
  const lastSavedJson = useRef(null);
  const contentBase = useRef(page.server_updated_at ?? null);

  const isDrawTool = activeToolType === 'freedraw';
  const isDrawToolRef = useRef(isDrawTool);
  isDrawToolRef.current = isDrawTool;

  // ---------- view (scroll/zoom) + paper ----------

  function currentView() {
    const st = apiRef.current?.getAppState();
    return st ? { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value } : null;
  }

  function syncPaper(view = currentView()) {
    const rect = sizeRef.current;
    if (!view || !rect.width || !paperRef.current) return;
    const s = settingsRef.current;
    const dims = sheetDims(s);
    drawPaper(paperRef.current, view, rect, dims, s.pageCount, s.pageStyle, paperColors(prefsRef.current.paperDark));

    // "Add page" button under the last sheet.
    const btn = addPageBtnRef.current;
    if (btn) {
      const top = (docHeight(s.pageCount, dims) + view.scrollY) * view.zoom + 14;
      const centerX = (dims.width / 2 + view.scrollX) * view.zoom;
      const visible = top < rect.height - 130 && top > -40;
      btn.style.transform = `translate(${Math.round(centerX - btn.offsetWidth / 2)}px, ${Math.round(top)}px)`;
      btn.style.visibility = visible ? 'visible' : 'hidden';
    }

    const centerSceneY = rect.height / 2 / view.zoom - view.scrollY;
    const sheet = sheetAt(centerSceneY, s.pageCount, dims);
    if (sheet !== currentSheetRef.current) {
      currentSheetRef.current = sheet;
      setCurrentSheet(sheet);
    }

    clearTimeout(viewSaveTimer.current);
    viewSaveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(viewKey(page.id), JSON.stringify(view));
      } catch {
        /* storage full/unavailable: only the remembered position is lost */
      }
    }, 400);
  }

  function applyView(view) {
    apiRef.current?.updateScene({ appState: { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom } } });
    syncPaper(view);
  }

  // Clamps any view change (wheel, Excalidraw's zoom buttons, hand tool) to
  // the notebook: no zooming out past one whole sheet, no losing the paper.
  function handleScrollChange(scrollX, scrollY, zoom) {
    const rect = sizeRef.current;
    const api = apiRef.current;
    if (!api || !rect.width) return;
    const s = settingsRef.current;
    const dims = sheetDims(s);
    const z = Math.min(Math.max(zoom.value, fitPageZoom(rect, dims)), MAX_ZOOM);
    const c = clampView(scrollX, scrollY, z, rect, dims, s.pageCount);
    if (z !== zoom.value || Math.abs(c.scrollX - scrollX) > 0.01 || Math.abs(c.scrollY - scrollY) > 0.01) {
      api.updateScene({ appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: z } } });
    }
    syncPaper({ ...c, zoom: z });
  }

  function resyncView() {
    const v = currentView();
    if (v) handleScrollChange(v.scrollX, v.scrollY, { value: v.zoom });
  }

  function initialView() {
    const rect = sizeRef.current;
    const s = settingsRef.current;
    const dims = sheetDims(s);
    const fit = fitPageZoom(rect, dims);
    const stored = readStoredView(page.id);
    if (stored) {
      const z = Math.min(Math.max(stored.zoom, fit), MAX_ZOOM);
      return { zoom: z, ...clampView(stored.scrollX, stored.scrollY, z, rect, dims, s.pageCount) };
    }
    return viewForSheet(0, fit, rect, dims, s.pageCount);
  }

  function resizeCanvases() {
    const el = containerRef.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = el.getBoundingClientRect();
    sizeRef.current = { width: rect.width, height: rect.height };
    for (const canvas of [paperRef.current, overlayRef.current]) {
      if (!canvas) continue;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
  }

  // Keep paper/overlay locked to the container through any resize
  // (keyboard, rotation, browser chrome, sidebar).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    resizeCanvases();
    const ro = new ResizeObserver(() => {
      resizeCanvases();
      resyncView();
      drawOverlay();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open where the user left off on this device, else the first sheet fitted
  // to the screen. Re-asserted for a short while after mount: Excalidraw
  // applies its own initialData restore asynchronously and would otherwise
  // revert an earlier view update (found empirically, see git history).
  useEffect(() => {
    const start = performance.now();
    const tick = () => {
      if (apiRef.current && sizeRef.current.width) applyView(initialView());
      if (performance.now() - start < 800) initialViewRAF.current = requestAnimationFrame(tick);
    };
    initialViewRAF.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(initialViewRAF.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopInitialView = () => cancelAnimationFrame(initialViewRAF.current);

  // Paper colours follow the theme.
  useEffect(() => {
    syncPaper();
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperDark, settings.pageStyle, settings.pageSize, settings.orientation, settings.pageCount]);

  // ---------- saving ----------

  function saveNow() {
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const api = apiRef.current;
    if (!api) return;
    const all = api.getSceneElementsIncludingDeleted();
    const version = getSceneVersion(all);
    if (version === savedVersion.current) return;
    savedVersion.current = version;
    const elements = pruneDeleted(all);
    const files = {};
    const allFiles = api.getFiles();
    for (const el of elements) {
      if (el.type === 'image' && !el.isDeleted && el.fileId && allFiles[el.fileId]) files[el.fileId] = allFiles[el.fileId];
    }
    const ink = { elements, appState: { viewBackgroundColor: 'transparent' }, files };
    lastSavedJson.current = JSON.stringify(ink);
    onChange(ink, { base: contentBase.current });
  }

  function scheduleSave() {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNow, 600);
  }

  // Never lose the last strokes: save on leaving the page and when the app
  // goes to the background (Android may kill it there).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', saveNow);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', saveNow);
      if (saveTimer.current) saveNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Changes from other devices arrive while this page is open: merge them
  // in stroke by stroke (Excalidraw's own reconciliation — anything being
  // drawn right now here wins), like live collaboration.
  useEffect(
    () =>
      on('pages-changed', async (ids) => {
        if (!ids.includes(page.id)) return;
        const row = await db.pages.get(page.id);
        const api = apiRef.current;
        if (!row || !api || row.server_updated_at === contentBase.current) return;
        if (row.ink_json === lastSavedJson.current) {
          contentBase.current = row.server_updated_at;
          return;
        }
        let remote;
        try {
          remote = JSON.parse(row.ink_json);
        } catch {
          return;
        }
        if (!Array.isArray(remote?.elements)) return;
        if (remote.files) api.addFiles(Object.values(remote.files));
        const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), pinCutJoints(remote.elements), api.getAppState());
        api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
        contentBase.current = row.server_updated_at;
        savedVersion.current = getSceneVersion(remote.elements);
        try {
          const rs = JSON.parse(row.canvas_settings || '{}');
          const patch = {};
          for (const key of ['pageSize', 'pageStyle', 'orientation']) if (rs[key] && rs[key] !== settingsRef.current[key]) patch[key] = rs[key];
          if ((rs.pageCount || 1) > settingsRef.current.pageCount) patch.pageCount = rs.pageCount;
          if (Object.keys(patch).length) setLocalSettings(patch);
        } catch {
          /* ignore malformed settings */
        }
        scheduleSave();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.id]
  );

  // ---------- settings ----------

  function setLocalSettings(patch) {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    requestAnimationFrame(resyncView);
    return next;
  }

  function updateSettings(patch) {
    onSettingsChange(setLocalSettings(patch));
  }

  function selectDrawMode(mode) {
    updateSettings({ tool: mode });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
    setSelectionTool(null);
  }

  function changePen(patch) {
    updateSettings({ tool: 'pen', ...(patch.color ? { penColor: patch.color } : {}), ...(patch.size ? { penSize: patch.size } : {}) });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
  }

  function changeHighlighter(patch) {
    updateSettings({ tool: 'highlighter', ...(patch.color ? { hlColor: patch.color } : {}), ...(patch.size ? { hlSize: patch.size } : {}) });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
  }

  // ---------- pages ----------

  function addPage(after = settingsRef.current.pageCount - 1) {
    const api = apiRef.current;
    const s = settingsRef.current;
    const dims = sheetDims(s);
    const n = s.pageCount;
    if (api && after < n - 1) {
      // Inserting in the middle: everything on later sheets moves down one.
      const from = sheetTop(after + 1, dims) - PAGE_GAP / 2;
      const dy = dims.height + PAGE_GAP;
      const elements = api
        .getSceneElementsIncludingDeleted()
        .map((el) => (!el.isDeleted && el.y >= from ? newElementWith(el, { y: el.y + dy }) : el));
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      scheduleSave();
    }
    updateSettings({ pageCount: n + 1 });
    const zoom = currentView()?.zoom ?? 1;
    requestAnimationFrame(() => applyView(viewForSheet(after + 1, zoom, sizeRef.current, dims, n + 1)));
  }

  function deletePage(i) {
    const api = apiRef.current;
    if (!api) return;
    const s = settingsRef.current;
    const dims = sheetDims(s);
    const top = sheetTop(i, dims) - PAGE_GAP / 2;
    const bottom = top + dims.height + PAGE_GAP;
    const dy = dims.height + PAGE_GAP;
    const all = api.getSceneElementsIncludingDeleted();
    const onPage = all.filter((el) => !el.isDeleted && el.y + el.height / 2 >= top && el.y + el.height / 2 < bottom);
    if (onPage.length && !window.confirm(t('canvas.deletePageConfirm', { n: i + 1 }))) return;
    const lastSheet = s.pageCount === 1;
    const elements = all.map((el) => {
      if (el.isDeleted) return el;
      const cy = el.y + el.height / 2;
      if (cy >= top && cy < bottom) return newElementWith(el, { isDeleted: true });
      if (!lastSheet && el.y >= bottom) return newElementWith(el, { y: el.y - dy });
      return el;
    });
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
    if (!lastSheet) updateSettings({ pageCount: s.pageCount - 1 });
    requestAnimationFrame(() => goToSheet(Math.min(i, Math.max(0, s.pageCount - 2))));
  }

  function goToSheet(i) {
    const s = settingsRef.current;
    const n = s.pageCount;
    const zoom = currentView()?.zoom ?? 1;
    applyView(viewForSheet(Math.min(Math.max(i, 0), n - 1), zoom, sizeRef.current, sheetDims(s), n));
  }

  // ---------- Excalidraw wiring ----------

  function handleExcalidrawAPI(api) {
    apiRef.current = api;
    if (initial.legacy) setTimeout(saveNow, 0); // persist the converted format once
  }

  function handleExcalidrawChange(elements, appState) {
    const tool = appState?.activeTool?.type;
    if (tool && tool !== activeToolType) setActiveToolType(tool);
    if (getSceneVersion(elements) !== savedVersion.current) scheduleSave();
  }

  useEffect(() => {
    if (savedVersion.current === null) savedVersion.current = getSceneVersion(initial.elements);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendShortcut(key, shift = false) {
    const target = containerRef.current?.querySelector('.excalidraw');
    target?.dispatchEvent(
      new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, metaKey: true, shiftKey: shift, bubbles: true, cancelable: true })
    );
  }
  const undo = () => sendShortcut('z');
  const redo = () => sendShortcut('z', true);

  // ---------- live overlay (stroke preview, snapped shape, eraser, selection) ----------

  function scheduleOverlay() {
    if (overlayRAF.current) return;
    overlayRAF.current = requestAnimationFrame(() => {
      overlayRAF.current = null;
      drawOverlay();
    });
  }

  function drawOverlay() {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    const d = drawing.current;
    if (d) {
      ctx.save();
      const v = currentView();
      if (v && d.sheet) {
        ctx.beginPath();
        ctx.rect((d.sheet.x + v.scrollX) * v.zoom, (d.sheet.y + v.scrollY) * v.zoom, d.sheet.width * v.zoom, d.sheet.height * v.zoom);
        ctx.clip();
      }
      ctx.globalAlpha = d.highlighter ? HIGHLIGHTER_OPACITY / 100 : 1;
      if (d.shape) {
        const pts = shapeOutline(d.shape.current);
        ctx.strokeStyle = d.color;
        ctx.lineWidth = inkWidth(d.size, d.highlighter ? 0.5 : avgPressure(d));
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      } else if (d.points.length) {
        const path = strokeToPath2D(
          d.points.map((p) => [p.x, p.y, p.pressure]),
          { ...STROKE_OPTIONS, size: d.size, last: false }
        );
        ctx.fillStyle = d.color;
        ctx.fill(path);
      }
      ctx.restore();
    }

    drawPendingErasure(ctx);
    const e = eraserCursor.current;
    if (e) {
      ctx.save();
      ctx.strokeStyle = 'rgba(115,115,115,0.9)';
      ctx.fillStyle = 'rgba(115,115,115,0.12)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, ERASER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    const sel = selectionDrawing.current;
    if (sel && sel.points.length >= 2) {
      const pts = sel.points;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#6965db';
      ctx.fillStyle = 'rgba(105, 101, 219, 0.08)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (sel.mode === 'rect') {
        const a = pts[0];
        const b = pts[pts.length - 1];
        ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
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

  // ---------- strokes ----------

  function localPoint(ev, rect, d) {
    const raw = ev.pressure;
    const pressure = d && (d.highlighter || d.pointerType !== 'pen') ? 0.5 : raw > 0 ? raw : 0.5;
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, pressure };
  }

  function avgPressure(d) {
    if (!d.points.length) return 0.5;
    const sum = d.points.reduce((acc, p) => acc + p.pressure, 0);
    return Math.min(1, Math.max(0.05, sum / d.points.length));
  }

  function capture(e) {
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
  }

  // The sheet (scene rect) under a container-relative point, or null when
  // the point is on the desk around / between the pages.
  function sheetUnder(p) {
    const v = currentView();
    if (!v) return null;
    const s = settingsRef.current;
    const dims = sheetDims(s);
    const x = p.x / v.zoom - v.scrollX;
    const y = p.y / v.zoom - v.scrollY;
    if (x < 0 || x > dims.width) return null;
    const top = sheetTop(sheetAt(y, s.pageCount, dims), dims);
    if (y < top || y > top + dims.height) return null;
    return { x: 0, y: top, width: dims.width, height: dims.height };
  }

  // Is a shape (screen coords) entirely on the stroke's sheet?
  function shapeOnSheet(shape, d) {
    const v = currentView();
    const r = d.sheet;
    if (!v || !r) return true;
    const tol = 0.5;
    return shapeOutline(shape).every((pt) => {
      const x = pt.x / v.zoom - v.scrollX;
      const y = pt.y / v.zoom - v.scrollY;
      return x >= r.x - tol && x <= r.x + r.width + tol && y >= r.y - tol && y <= r.y + r.height + tol;
    });
  }

  // Ink only goes on paper: a stroke can't start on the desk, and one that
  // runs off the page is cut at its edge (see endStroke).
  function startStroke(e) {
    const rect = containerRef.current.getBoundingClientRect();
    gestureRect.current = rect;
    const sheet = sheetUnder(localPoint(e, rect));
    if (!sheet) return false;
    const s = settingsRef.current;
    const highlighter = s.tool === 'highlighter';
    const d = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      highlighter,
      color: highlighter ? s.hlColor : s.penColor,
      size: highlighter ? s.hlSize : s.penSize,
      points: [],
      shape: null,
      holdAnchor: null,
      holdTimer: null,
      sheet,
    };
    d.points.push(localPoint(e, rect, d));
    drawing.current = d;
    capture(e);
    scheduleOverlay();
    return true;
  }

  function moveStroke(e) {
    const d = drawing.current;
    const rect = gestureRect.current;
    const native = e.nativeEvent || e;
    const events = native.getCoalescedEvents?.();
    for (const ev of events && events.length ? events : [native]) d.points.push(localPoint(ev, rect, d));
    const p = d.points[d.points.length - 1];
    if (d.shape) {
      const next = adjustShape(d.shape.base, d.shape.grab, p);
      if (shapeOnSheet(next, d)) d.shape.current = next;
    } else if (prefsRef.current.shapeSnap) {
      const radius = HOLD_RADIUS[d.pointerType] ?? 6;
      if (!d.holdAnchor || Math.hypot(p.x - d.holdAnchor.x, p.y - d.holdAnchor.y) > radius) {
        d.holdAnchor = p;
        clearTimeout(d.holdTimer);
        d.holdTimer = setTimeout(() => trySnap(d), HOLD_MS);
      }
    }
    scheduleOverlay();
  }

  // Pen held still at the end of a stroke: turn it into a clean shape that
  // keeps following the pen until it's lifted.
  function trySnap(d) {
    if (drawing.current !== d || d.shape) return;
    const shape = recognizeShape(d.points);
    if (!shape || !shapeOnSheet(shape, d)) return;
    const grab = d.points[d.points.length - 1];
    d.shape = { base: shape, grab, current: shape };
    try {
      navigator.vibrate?.(12);
    } catch {
      /* no vibration support */
    }
    scheduleOverlay();
  }

  function cancelStroke() {
    if (drawing.current) clearTimeout(drawing.current.holdTimer);
    drawing.current = null;
    scheduleOverlay();
  }

  function endStroke() {
    const d = drawing.current;
    if (!d) return;
    clearTimeout(d.holdTimer);
    drawing.current = null;
    scheduleOverlay();
    const api = apiRef.current;
    if (!api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    const toScene = (p) => ({ x: p.x / zoom - st.scrollX, y: p.y / zoom - st.scrollY });
    const opacity = d.highlighter ? HIGHLIGHTER_OPACITY : 100;

    let added;
    if (d.shape) {
      const strokeWidth = inkWidth(d.size, d.highlighter ? 0.5 : avgPressure(d)) / zoom;
      added = shapeToElements(d.shape.current, toScene, { color: d.color, strokeWidth, opacity, zoom });
    } else {
      const pts = d.points.map((p) => ({ ...toScene(p), pressure: p.pressure }));
      // A tap is a dot (the i's and full stops of handwriting).
      if (pts.length === 1) pts.push({ ...pts[0], x: pts[0].x + 0.1 / zoom });
      const r = d.sheet;
      const onSheet = (p) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
      const runs = pts.every(onSheet)
        ? [pts]
        : clipPolylineByPolygon(pts, [
            { x: r.x, y: r.y },
            { x: r.x + r.width, y: r.y },
            { x: r.x + r.width, y: r.y + r.height },
            { x: r.x, y: r.y + r.height },
          ]).insideRuns;
      added = runs
        .filter((run) => run.length >= 2)
        .map((run) => {
          const el = strokeToFreedrawElement({
            points: run,
            color: d.color,
            size: d.size / (EXCALIDRAW_FREEDRAW_SIZE_FACTOR * zoom),
            simulatePressure: false,
          });
          el.opacity = opacity;
          el.roughness = 0;
          return el;
        });
      if (!added.length) return;
    }
    const existing = api.getSceneElementsIncludingDeleted();
    // Highlighter goes underneath the ink, like on paper.
    const elements = d.highlighter ? [...added, ...existing] : [...existing, ...added];
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
  }

  // ---------- stylus-button eraser ----------
  //
  // Like Excalidraw's own eraser: strokes touched during the gesture are
  // shown faded, and all deleted together when the pen lifts — one undo
  // step. (Deleting them live and "committing" at the end doesn't work:
  // Excalidraw's updateScene leaves already-applied changes out of the
  // undo history.)

  function eraseAt(p) {
    const api = apiRef.current;
    const er = erasing.current;
    if (!api || !er) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    const scene = { x: p.x / zoom - st.scrollX, y: p.y / zoom - st.scrollY };
    const radius = ERASER_RADIUS / zoom;
    for (const el of api.getSceneElements()) {
      if (!er.pending.has(el.id) && eraserHits(el, scene, radius)) er.pending.set(el.id, el);
    }
  }

  function startErase(e) {
    const rect = containerRef.current.getBoundingClientRect();
    gestureRect.current = rect;
    const p = localPoint(e, rect);
    erasing.current = { pointerId: e.pointerId, last: p, pending: new Map() };
    eraserCursor.current = p;
    capture(e);
    eraseAt(p);
    scheduleOverlay();
  }

  function moveErase(e) {
    const er = erasing.current;
    const p = localPoint(e, gestureRect.current);
    // Sample along the movement so fast swipes don't skip strokes.
    const steps = Math.max(1, Math.ceil(Math.hypot(p.x - er.last.x, p.y - er.last.y) / (ERASER_RADIUS / 2)));
    for (let i = 1; i <= steps; i++) {
      eraseAt({ x: er.last.x + ((p.x - er.last.x) * i) / steps, y: er.last.y + ((p.y - er.last.y) * i) / steps });
    }
    er.last = p;
    eraserCursor.current = p;
    scheduleOverlay();
  }

  function endErase() {
    const er = erasing.current;
    erasing.current = null;
    eraserCursor.current = null;
    scheduleOverlay();
    const api = apiRef.current;
    if (!api || !er?.pending.size) return;
    const elements = api
      .getSceneElementsIncludingDeleted()
      .map((el) => (er.pending.has(el.id) ? newElementWith(el, { isDeleted: true }) : el));
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
  }

  // Fades the strokes an erase gesture has touched so far.
  function drawPendingErasure(ctx) {
    const er = erasing.current;
    const api = apiRef.current;
    if (!er?.pending.size || !api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.82)';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const el of er.pending.values()) {
      const outline = getCuttableOutline(el);
      if (!outline) {
        ctx.fillRect((el.x + st.scrollX) * zoom, (el.y + st.scrollY) * zoom, el.width * zoom, el.height * zoom);
        continue;
      }
      const w = el.type === 'freedraw' ? el.strokeWidth * EXCALIDRAW_FREEDRAW_SIZE_FACTOR * 1.6 : el.strokeWidth + 2;
      ctx.lineWidth = w * zoom + 3;
      ctx.beginPath();
      outline.forEach((pt, i) => {
        const x = (pt.x + st.scrollX) * zoom;
        const y = (pt.y + st.scrollY) * zoom;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      if (outline.length === 1) ctx.lineTo((outline[0].x + st.scrollX) * zoom + 0.1, (outline[0].y + st.scrollY) * zoom);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- finger scrolling, pinch, taps ----------

  function stopInertia() {
    if (inertiaRAF.current) cancelAnimationFrame(inertiaRAF.current);
    inertiaRAF.current = null;
  }

  function panBy(dx, dy) {
    const v = currentView();
    const rect = sizeRef.current;
    if (!v || !rect.width) return false;
    const s = settingsRef.current;
    const c = clampView(v.scrollX + dx / v.zoom, v.scrollY + dy / v.zoom, v.zoom, rect, sheetDims(s), s.pageCount);
    const moved = Math.abs(c.scrollX - v.scrollX) > 0.001 || Math.abs(c.scrollY - v.scrollY) > 0.001;
    if (moved) applyView({ ...c, zoom: v.zoom });
    return moved;
  }

  function startInertia(vx, vy) {
    stopInertia();
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay;
      vy *= decay;
      if (Math.hypot(vx, vy) < 0.03 || !panBy(vx * dt, vy * dt)) {
        inertiaRAF.current = null;
        return;
      }
      inertiaRAF.current = requestAnimationFrame(step);
    };
    inertiaRAF.current = requestAnimationFrame(step);
  }

  function startPinch() {
    const v = currentView();
    if (!v) return;
    const [p1, p2] = [...touchPoints.current.values()];
    pinchTrack.current = {
      prevDist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
      prevMidX: (p1.x + p2.x) / 2,
      prevMidY: (p1.y + p2.y) / 2,
      zoom: v.zoom,
      scrollX: v.scrollX,
      scrollY: v.scrollY,
    };
  }

  // Incremental (frame-to-frame) pinch: a single noisy touch sample can't
  // throw the rest of the gesture off (see git history for the details).
  function updatePinch() {
    const api = apiRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    const pin = pinchTrack.current;
    if (!api || !rect || !rect.width || !pin) return;
    const [p1, p2] = [...touchPoints.current.values()];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    if (dist < 8 || pin.prevDist < 8) {
      pin.prevDist = dist;
      pin.prevMidX = midX;
      pin.prevMidY = midY;
      return;
    }
    const s = settingsRef.current;
    const dims = sheetDims(s);
    const zoom = Math.min(Math.max(pin.zoom * (dist / pin.prevDist), fitPageZoom(rect, dims)), MAX_ZOOM);
    const anchorX = (pin.prevMidX - rect.left) / pin.zoom - pin.scrollX;
    const anchorY = (pin.prevMidY - rect.top) / pin.zoom - pin.scrollY;
    const c = clampView((midX - rect.left) / zoom - anchorX, (midY - rect.top) / zoom - anchorY, zoom, rect, dims, s.pageCount);
    applyView({ ...c, zoom });
    Object.assign(pin, { prevDist: dist, prevMidX: midX, prevMidY: midY, zoom, scrollX: c.scrollX, scrollY: c.scrollY });
  }

  // Double-tap: fit the whole sheet; on a fitted sheet, zoom to the page
  // width around where you tapped (handy on phones in portrait).
  function toggleFit(clientY) {
    const rect = containerRef.current?.getBoundingClientRect();
    const v = currentView();
    if (!rect || !v) return;
    const s = settingsRef.current;
    const dims = sheetDims(s);
    const fitP = fitPageZoom(rect, dims);
    const fitW = Math.min(fitWidthZoom(rect, dims), MAX_ZOOM);
    const sceneY = (clientY - rect.top) / v.zoom - v.scrollY;
    if (Math.abs(v.zoom - fitP) < 0.01 && fitW > fitP * 1.08) {
      const scrollY = (clientY - rect.top) / fitW - sceneY;
      applyView({ zoom: fitW, ...clampView(rect.width / (2 * fitW) - dims.width / 2, scrollY, fitW, rect, dims, s.pageCount) });
    } else {
      applyView(viewForSheet(sheetAt(sceneY, s.pageCount, dims), fitP, rect, dims, s.pageCount));
    }
  }

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
      toggleFit(e.clientY);
    } else {
      lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    }
  }

  // ---------- pointer routing (capture phase, before Excalidraw) ----------
  //
  //  - Pen/mouse/finger strokes while the pen tool is on are drawn by us
  //    (real pressure, hold-to-snap, highlighter). Every other tool gets
  //    the input natively, so Excalidraw's eraser/select/shapes/text work.
  //  - The stylus button / eraser end erases strokes, whatever the tool.
  //  - Fingers: draw (if "finger draws" is on), else one finger scrolls the
  //    notebook (with momentum), two fingers pinch-zoom/pan, two-finger tap
  //    undoes, double-tap fits. Touches near pen activity or with a
  //    palm-sized contact are a resting hand and are ignored.

  function consume(e) {
    e.stopPropagation();
    e.preventDefault();
  }

  function handlePointerDownCapture(e) {
    // Only the drawing surface itself: taps on any UI floating above it
    // (Excalidraw's toolbar and menus, the page navigator, text being
    // edited) must keep working normally with every pointer type.
    if (!(e.target instanceof HTMLCanvasElement) && e.target !== containerRef.current) return;
    stopInertia();
    stopInitialView();
    const fingerSelects = e.pointerType !== 'touch' || prefsRef.current.fingerDraws;
    if (selectionTool && fingerSelects && !(e.pointerType === 'touch' && Date.now() - lastPenActivity.current < PALM_WINDOW_MS)) {
      if (selectionDrawing.current) {
        consume(e);
        return;
      }
      if (e.pointerType === 'pen') lastPenActivity.current = Date.now();
      consume(e);
      const rect = containerRef.current.getBoundingClientRect();
      gestureRect.current = rect;
      selectionDrawing.current = { pointerId: e.pointerId, mode: selectionTool, points: [localPoint(e, rect)] };
      capture(e);
      return;
    }

    if (e.pointerType === 'pen') {
      lastPenActivity.current = Date.now();
      if (!useSettings.getState().penSeen) updatePrefs({ penSeen: true });
      // A palm that landed just before the pen: undo its scroll.
      if (touchPan.current) {
        applyView(touchPan.current.startView);
        touchPan.current = null;
      }
      if (drawing.current?.pointerType === 'touch') cancelStroke();
      if (isEraserButton(e)) {
        consume(e);
        startErase(e);
        return;
      }
      if (!isDrawToolRef.current) return;
      consume(e);
      startStroke(e);
      return;
    }

    if (e.pointerType === 'mouse') {
      if (!isDrawToolRef.current || e.button !== 0) return;
      consume(e);
      startStroke(e);
      return;
    }

    if (e.pointerType !== 'touch') return;
    const palm =
      (e.width > PALM_SIZE && e.height > PALM_SIZE) ||
      drawing.current?.pointerType === 'pen' ||
      erasing.current ||
      Date.now() - lastPenActivity.current < PALM_WINDOW_MS;
    if (palm) {
      consume(e);
      ignoredTouches.current.add(e.pointerId);
      return;
    }

    touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });

    if (touchPoints.current.size >= 2) {
      // The first finger was really the start of a pinch.
      if (drawing.current?.pointerType === 'touch') cancelStroke();
      touchPan.current = null;
      touchTrack.current = null;
      consume(e);
      startPinch();
      twoFingerTap.current = touchPoints.current.size === 2 ? { start: Date.now(), moved: false } : null;
      return;
    }

    if (isDrawToolRef.current || selectionTool) {
      consume(e);
      touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, consumed: true };
      // A finger that draws still scrolls when it lands on the desk.
      if (!(prefsRef.current.fingerDraws && !selectionTool && startStroke(e))) {
        touchPan.current = {
          pointerId: e.pointerId,
          lastX: e.clientX,
          lastY: e.clientY,
          startView: currentView(),
          samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
        };
        capture(e);
      }
      return;
    }

    // Other tools: only pre-empt what looks like the second tap of a
    // double-tap, so Excalidraw's own double-tap zoom doesn't fire too.
    const now = Date.now();
    const last = lastTap.current;
    const secondTap = !!last && now - last.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_DIST;
    touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, consumed: secondTap };
    if (secondTap) consume(e);
  }

  function handlePointerMoveCapture(e) {
    if (e.pointerType === 'pen') lastPenActivity.current = Date.now();
    if (ignoredTouches.current.has(e.pointerId)) {
      consume(e);
      return;
    }
    const sel = selectionDrawing.current;
    if (sel && e.pointerId === sel.pointerId) {
      consume(e);
      sel.points.push(localPoint(e, gestureRect.current));
      scheduleOverlay();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      consume(e);
      moveStroke(e);
      return;
    }
    if (erasing.current && e.pointerId === erasing.current.pointerId) {
      consume(e);
      moveErase(e);
      return;
    }
    if (!touchPoints.current.has(e.pointerId)) return;

    const tp = touchPoints.current.get(e.pointerId);
    tp.x = e.clientX;
    tp.y = e.clientY;

    if (touchPoints.current.size >= 2 && pinchTrack.current) {
      consume(e);
      if (twoFingerTap.current && Math.hypot(tp.x - tp.startX, tp.y - tp.startY) > 12) twoFingerTap.current.moved = true;
      if (!pinchRAF.current) {
        pinchRAF.current = requestAnimationFrame(() => {
          pinchRAF.current = null;
          if (touchPoints.current.size >= 2 && pinchTrack.current) updatePinch();
        });
      }
      return;
    }

    const pan = touchPan.current;
    if (pan && pan.pointerId === e.pointerId) {
      consume(e);
      // Content follows the finger.
      panBy(e.clientX - pan.lastX, e.clientY - pan.lastY);
      pan.lastX = e.clientX;
      pan.lastY = e.clientY;
      const now = performance.now();
      pan.samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (pan.samples.length > 2 && now - pan.samples[0].t > 100) pan.samples.shift();
      return;
    }

    if (touchTrack.current?.pointerId === e.pointerId && touchTrack.current.consumed) consume(e);
  }

  function handlePointerUpCapture(e) {
    if (ignoredTouches.current.delete(e.pointerId)) {
      consume(e);
      return;
    }
    const sel = selectionDrawing.current;
    if (sel && e.pointerId === sel.pointerId) {
      consume(e);
      finalizeSelection();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      consume(e);
      if (e.type === 'pointercancel') cancelStroke();
      else endStroke();
      if (e.pointerType === 'touch') {
        touchPoints.current.delete(e.pointerId);
        touchTrack.current = null;
      }
      return;
    }
    if (erasing.current && e.pointerId === erasing.current.pointerId) {
      consume(e);
      endErase();
      return;
    }
    if (!touchPoints.current.has(e.pointerId)) return;

    const wasPinching = touchPoints.current.size >= 2 && !!pinchTrack.current;
    const track = touchTrack.current?.pointerId === e.pointerId ? touchTrack.current : null;
    const pan = touchPan.current?.pointerId === e.pointerId ? touchPan.current : null;
    touchPoints.current.delete(e.pointerId);

    if (touchPoints.current.size < 2) {
      pinchTrack.current = null;
      if (pinchRAF.current) cancelAnimationFrame(pinchRAF.current);
      pinchRAF.current = null;
    }
    const tap = twoFingerTap.current;
    if (tap && touchPoints.current.size === 0) {
      twoFingerTap.current = null;
      if (!tap.moved && Date.now() - tap.start < TWO_FINGER_TAP_MS) undo();
    }

    if (pan) {
      touchPan.current = null;
      consume(e);
      const samples = pan.samples;
      if (samples.length >= 2) {
        const a = samples[0];
        const b = samples[samples.length - 1];
        const dt = b.t - a.t;
        if (dt > 0 && performance.now() - b.t < 60) startInertia((b.x - a.x) / dt, (b.y - a.y) / dt);
      }
    }
    if (track) {
      touchTrack.current = null;
      if (track.consumed) consume(e);
      handleTapForDoubleTap(e, track);
      return;
    }
    if (wasPinching) consume(e);
  }

  // ---------- MS-Paint-style cut selection ----------

  useEffect(() => {
    if (activeToolType !== 'selection') setSelectionTool(null);
  }, [activeToolType]);

  function selectTool(mode) {
    setSelectionTool((prev) => {
      const next = prev === mode ? null : mode;
      if (next) apiRef.current?.setActiveTool({ type: 'selection' });
      return next;
    });
  }

  function chooseSelectionVariant(mode) {
    setSelectionVariant(mode);
    setSelectionMenuOpen(false);
    setSelectionTool(mode);
    apiRef.current?.setActiveTool({ type: 'selection' });
  }

  useEffect(() => {
    if (!selectionMenuOpen) return undefined;
    const handleOutside = (e) => {
      if (!e.target.closest?.('.quarc-selection-tool')) setSelectionMenuOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside, true);
    return () => document.removeEventListener('pointerdown', handleOutside, true);
  }, [selectionMenuOpen]);

  // Excalidraw's tool row (".App-toolbar > .Stack_horizontal") is a real,
  // persistent DOM node; our selection button is portaled into it so it
  // looks and behaves like a native tool.
  useEffect(() => {
    let cancelled = false;
    let raf;
    const poll = () => {
      if (cancelled) return;
      const el = containerRef.current?.querySelector('.App-toolbar > .Stack_horizontal');
      if (el) setToolbarPortalEl(el);
      else raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Cuts every stroke/shape crossing the drawn region at its boundary and
  // selects the inside pieces as one group (see canvas/selectionCut.js).
  function finalizeSelection() {
    const sel = selectionDrawing.current;
    selectionDrawing.current = null;
    scheduleOverlay();
    const api = apiRef.current;
    if (!sel || !api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    const toScene = (p) => ({ x: p.x / zoom - st.scrollX, y: p.y / zoom - st.scrollY });

    let polygon;
    if (sel.mode === 'rect') {
      const a = toScene(sel.points[0]);
      const b = toScene(sel.points[sel.points.length - 1]);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      if (maxX - minX < 3 || maxY - minY < 3) return;
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

    const newElements = [];
    const selectedElementIds = {};
    for (const el of api.getSceneElementsIncludingDeleted()) {
      if (el.isDeleted) {
        newElements.push(el);
        continue;
      }
      const outline = getCuttableOutline(el);
      if (outline) {
        // Pieces are prepared to meet at the cut without a gap (see cutOutline).
        const shape = el.type !== 'freedraw';
        const { insideRuns, outsideRuns } = cutOutline(outline, polygon, { shape, step: Math.max(0.25, el.strokeWidth / 2) });
        if (insideRuns.length === 0) {
          newElements.push(el);
          continue;
        }
        if (outsideRuns.length === 0) {
          newElements.push(el);
          selectedElementIds[el.id] = true;
          continue;
        }
        // A cut shape's pieces become ink of the same visible width (a
        // freedraw of strokeWidth w is drawn ~6w wide at even pressure).
        const size = shape ? el.strokeWidth / (EXCALIDRAW_FREEDRAW_SIZE_FACTOR * 2 * Math.SQRT1_2) : el.strokeWidth;
        const piece = (run) => {
          const p = strokeToFreedrawElement({ points: run, color: el.strokeColor, size, simulatePressure: el.type === 'freedraw' && el.simulatePressure });
          p.opacity = el.opacity;
          return p;
        };
        // Replaced, not just dropped: a deletion (bumped version) is what
        // tells other devices' copies to let go of the uncut original.
        newElements.push(newElementWith(el, { isDeleted: true }));
        for (const run of outsideRuns) if (run.length >= 2) newElements.push(piece(run));
        for (const run of insideRuns) {
          if (run.length < 2) continue;
          const p = piece(run);
          newElements.push(p);
          selectedElementIds[p.id] = true;
        }
      } else {
        newElements.push(el);
        if (boundingBoxIntersectsPolygon(el, polygon)) selectedElementIds[el.id] = true;
      }
    }

    // Several selected pieces share a fresh group, so Excalidraw draws one
    // box around them instead of one per piece.
    let finalElements = newElements;
    const ids = Object.keys(selectedElementIds);
    const appStatePatch = { selectedElementIds, selectedGroupIds: {} };
    if (ids.length > 1) {
      const groupId = crypto.randomUUID();
      finalElements = newElements.map((el) => (selectedElementIds[el.id] ? newElementWith(el, { groupIds: [...el.groupIds, groupId] }) : el));
      appStatePatch.selectedGroupIds = { [groupId]: true };
    }
    api.updateScene({ elements: finalElements, appState: appStatePatch, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
    // Hand straight over to plain select, so the next drag moves the cut.
    setSelectionTool(null);
  }

  function renderSelectionToolButton() {
    if (!toolbarPortalEl) return null;
    const icon = selectionVariant === 'freeform' ? FreeformSelectIcon : RectSelectIcon;
    return createPortal(
      <div className="quarc-selection-tool" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <label className="ToolIcon" title={t('canvas.selectionTool')}>
          <input
            type="radio"
            className="ToolIcon_type_radio ToolIcon_size_medium"
            checked={selectionTool === selectionVariant}
            onChange={() => selectTool(selectionVariant)}
          />
          <div className="ToolIcon__icon">{icon}</div>
        </label>
        <button type="button" className="quarc-selection-tool__caret" title={t('canvas.selectionToolVariant')} onClick={() => setSelectionMenuOpen((v) => !v)}>
          {ChevronDownIcon}
        </button>
        {selectionMenuOpen && (
          <div className="dropdown-menu quarc-selection-tool__menu">
            <div className="dropdown-menu-container Island" style={{ '--padding': 2 }}>
              {[
                ['rect', RectSelectIcon, t('canvas.rectSelect')],
                ['freeform', FreeformSelectIcon, t('canvas.freeSelect')],
              ].map(([mode, ic, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`dropdown-menu-item dropdown-menu-item-base${selectionVariant === mode ? ' dropdown-menu-item--selected' : ''}`}
                  onClick={() => chooseSelectionVariant(mode)}
                >
                  <div className="dropdown-menu-item__text">
                    {ic}
                    {label}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>,
      toolbarPortalEl
    );
  }

  // ---------- render ----------

  const colors = paperColors(paperDark);
  const inkFilter = paperDark ? DARK_INK_FILTER : undefined;
  const n = settings.pageCount;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CanvasToolbar
        drawMode={isDrawTool ? settings.tool : null}
        onDrawMode={selectDrawMode}
        pen={{ color: settings.penColor, size: settings.penSize }}
        highlighter={{ color: settings.hlColor, size: settings.hlSize }}
        onPenChange={changePen}
        onHighlighterChange={changeHighlighter}
        shapeSnap={shapeSnap}
        onToggleShapeSnap={() => updatePrefs({ shapeSnap: !shapeSnap })}
        fingerDraws={fingerDraws}
        onToggleFinger={() => updatePrefs({ fingerMode: fingerDraws ? 'scroll' : 'draw' })}
        settings={settings}
        onSettings={updateSettings}
        paperFollowsTheme={paperFollowsTheme}
        onPaperFollowsTheme={(v) => updatePrefs({ paperFollowsTheme: v })}
        onUndo={undo}
        onRedo={redo}
        onAddPage={() => addPage(currentSheetRef.current)}
        inkFilter={inkFilter}
      />
      <div
        ref={containerRef}
        className={`quarc-canvas-page relative min-h-0 flex-1 overflow-hidden ${isDrawTool ? 'quarc-pen-active' : ''}`}
        style={{ backgroundColor: colors.desk, touchAction: 'none', cursor: selectionTool ? 'crosshair' : undefined }}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerUpCapture={handlePointerUpCapture}
        onPointerCancelCapture={handlePointerUpCapture}
        onLostPointerCapture={(e) => {
          if (drawing.current?.pointerId === e.pointerId) endStroke();
        }}
      >
        <style>{`
          .quarc-canvas-page.quarc-pen-active .App-menu__left { display: none !important; }
          .quarc-canvas-page .excalidraw { --color-primary: #f59e0b; --color-primary-darker: #d97706; --color-primary-darkest: #b45309; --color-primary-light: #fef3c7; --color-primary-light-darker: #fde68a; --color-primary-hover: #d97706; }
          .quarc-canvas-page .excalidraw.theme--dark { --color-primary-light: #78350f; --color-primary-light-darker: #92400e; }
          .quarc-canvas-page .quarc-selection-tool { margin-left: 2px; }
          .quarc-canvas-page .quarc-selection-tool__caret { width: 14px; align-self: stretch; display: flex; align-items: center; justify-content: center; border: 0; background: transparent; cursor: pointer; color: var(--color-on-surface); border-radius: var(--border-radius-md); }
          .quarc-canvas-page .quarc-selection-tool__caret:hover { background-color: var(--button-hover-bg); }
          .quarc-canvas-page .quarc-selection-tool__menu { left: 0; z-index: 2; min-width: 9.5rem; }
          .quarc-canvas-page .quarc-selection-tool__menu .dropdown-menu-container { display: flex; flex-direction: column; gap: 2px; padding: 4px; }
        `}</style>
        <canvas ref={paperRef} className="pointer-events-none absolute inset-0" />
        <Excalidraw
          excalidrawAPI={handleExcalidrawAPI}
          initialData={{
            elements: initial.elements,
            files: initial.files,
            appState: {
              viewBackgroundColor: 'transparent',
              activeTool: { type: 'freedraw' },
              currentItemRoughness: 0,
              currentItemStrokeColor: settings.penColor,
            },
          }}
          onChange={handleExcalidrawChange}
          onScrollChange={handleScrollChange}
          theme={paperDark ? 'dark' : 'light'}
          langCode={i18n.language === 'tr' ? 'tr-TR' : 'en'}
          UIOptions={UI_OPTIONS}
        />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" style={{ filter: inkFilter }} />

        <button
          ref={addPageBtnRef}
          type="button"
          onClick={() => addPage(settingsRef.current.pageCount - 1)}
          className="absolute left-0 top-0 z-[3] flex items-center gap-1.5 rounded-full border border-dashed border-neutral-400 bg-white/80 px-3 py-1.5 text-sm font-medium text-neutral-600 shadow-sm backdrop-blur hover:border-accent hover:text-accent-dark dark:border-neutral-600 dark:bg-neutral-800/80 dark:text-neutral-300"
          style={{ visibility: 'hidden' }}
        >
          <Plus size={16} /> {t('canvas.addPage')}
        </button>

        <div className="pointer-events-none absolute inset-x-0 bottom-[72px] z-[4] flex justify-center min-[730px]:bottom-4">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-neutral-200 bg-white/90 p-1 text-sm shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-800/90">
            <button
              type="button"
              title={t('canvas.prevPage')}
              disabled={currentSheet === 0}
              onClick={() => goToSheet(currentSheet - 1)}
              className="rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <ChevronUp size={16} />
            </button>
            <span className="min-w-[3.5rem] text-center tabular-nums text-neutral-700 dark:text-neutral-200">
              {currentSheet + 1} / {n}
            </span>
            <button
              type="button"
              title={t('canvas.nextPage')}
              disabled={currentSheet >= n - 1}
              onClick={() => goToSheet(currentSheet + 1)}
              className="rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              title={t('canvas.addPage')}
              onClick={() => addPage(currentSheet)}
              className="rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <Plus size={16} />
            </button>
            <span ref={pageMenuBtnRef}>
              <button
                type="button"
                title={t('canvas.pageMenu')}
                onClick={() => setPageMenuOpen((v) => !v)}
                className="rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                <MoreHorizontal size={16} />
              </button>
            </span>
          </div>
        </div>
        <Popover anchorRef={pageMenuBtnRef} open={pageMenuOpen} onClose={() => setPageMenuOpen(false)} align="center" className="w-56">
          <MenuItem
            icon={FilePlus2}
            onClick={() => {
              setPageMenuOpen(false);
              addPage(currentSheet);
            }}
          >
            {t('canvas.addPageAfter')}
          </MenuItem>
          <MenuItem
            icon={ArrowUpToLine}
            disabled={currentSheet === 0}
            onClick={() => {
              setPageMenuOpen(false);
              goToSheet(0);
            }}
          >
            {t('canvas.firstPage')}
          </MenuItem>
          <MenuItem
            icon={ArrowDownToLine}
            disabled={currentSheet >= n - 1}
            onClick={() => {
              setPageMenuOpen(false);
              goToSheet(n - 1);
            }}
          >
            {t('canvas.lastPage')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            danger
            onClick={() => {
              setPageMenuOpen(false);
              deletePage(currentSheet);
            }}
          >
            {n > 1 ? t('canvas.deletePage') : t('canvas.clearPage')}
          </MenuItem>
        </Popover>
        {renderSelectionToolButton()}
      </div>
    </div>
  );
}
