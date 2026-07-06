import { useMemo, useRef, useState } from 'react';
import { Excalidraw, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { isLegacyInkFormat, convertLegacyInk } from '../../lib/inkMigration';
import { strokeToFreedrawElement } from '../../lib/freehandElement';
import { strokeToPath2D, STROKE_OPTIONS } from '../../lib/freehand';

const PAGE_SIZES = {
  A5: { ratio: '148 / 210', label: 'A5' },
  A4: { ratio: '210 / 297', label: 'A4' },
  Letter: { ratio: '216 / 279', label: 'Letter' },
};

const DEFAULT_SETTINGS = { pageSize: 'A5', pageStyle: 'lined' };

const LINE_HEIGHT = 28;
const GRID_SIZE = 28;

function pageBackgroundStyle(pageStyle) {
  if (pageStyle === 'lined') {
    return {
      backgroundColor: '#fff',
      backgroundImage: `repeating-linear-gradient(to bottom, transparent, transparent ${LINE_HEIGHT - 1}px, #d6e4f0 ${LINE_HEIGHT - 1}px, #d6e4f0 ${LINE_HEIGHT}px)`,
    };
  }
  if (pageStyle === 'squared') {
    return {
      backgroundColor: '#fff',
      backgroundImage:
        `repeating-linear-gradient(to bottom, transparent, transparent ${GRID_SIZE - 1}px, #e2e8f0 ${GRID_SIZE - 1}px, #e2e8f0 ${GRID_SIZE}px),` +
        `repeating-linear-gradient(to right, transparent, transparent ${GRID_SIZE - 1}px, #e2e8f0 ${GRID_SIZE - 1}px, #e2e8f0 ${GRID_SIZE}px)`,
    };
  }
  return { backgroundColor: '#fff' };
}

export default function CanvasPage({ page, onChange, onSettingsChange }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(page.canvas_settings || DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  // Pen mode = our own reliable pressure-capture path (real e.pressure, gated
  // on pointerType === 'pen'), bypassing Excalidraw's own freedraw pressure
  // heuristic, which decides "simulate vs. real" from a single sample at
  // pointer-down and is unreliable across real stylus hardware. Off = normal
  // Excalidraw tools (select/shapes/text/eraser/its own pencil for mouse).
  const [penMode, setPenMode] = useState(true);
  const excalidrawAPIRef = useRef(null);
  const containerRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const drawing = useRef(null); // { pointerId, points: [{x,y,clientX,clientY,pressure}], color, size }
  const saveTimer = useRef(null);

  const initialData = useMemo(() => {
    const raw = page.ink_json;
    if (isLegacyInkFormat(raw)) {
      const converted = convertLegacyInk(raw);
      // Persist the converted format immediately so we don't reconvert (and
      // don't lose it) on the next load.
      onChange(converted);
      return converted;
    }
    return {
      elements: raw?.elements || [],
      appState: { viewBackgroundColor: 'transparent', ...(raw?.appState || {}) },
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

  function handleExcalidrawChange() {
    // Fires for changes made via Excalidraw's own tools (shapes/text/select/
    // move/erase/its own pencil) — our custom pen path saves separately since
    // it mutates the scene imperatively via updateScene, below.
    scheduleSave();
  }

  function updateSettings(patch) {
    const next = { ...settings, ...patch };
    setSettings(next);
    onSettingsChange(next);
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

  // Capture phase on the page container: only ever intercepts real pen
  // input while pen mode is on. Touch/mouse pointers are never touched here
  // (no stopPropagation), so they fall through to Excalidraw untouched —
  // that's what gives us native 1-finger pan / 2-finger pinch-zoom for free.
  function handlePointerDownCapture(e) {
    if (!penMode || e.pointerType !== 'pen') return;
    e.stopPropagation();
    e.preventDefault();
    drawing.current = { pointerId: e.pointerId, points: [getPoint(e)], color: '#1f2937', size: 3 };
  }

  function handlePointerMoveCapture(e) {
    if (!drawing.current || e.pointerId !== drawing.current.pointerId) return;
    e.stopPropagation();
    e.preventDefault();
    drawing.current.points.push(getPoint(e));
    redrawOverlay();
  }

  function handlePointerUpCapture(e) {
    if (!drawing.current || e.pointerId !== drawing.current.pointerId) return;
    e.stopPropagation();
    e.preventDefault();
    finalizeStroke();
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
      size: stroke.size / (appState.zoom?.value || 1),
      simulatePressure: false,
    });

    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element] });
    scheduleSave();
  }

  const size = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.A5;

  return (
    <div className="relative flex h-full flex-col bg-neutral-200 dark:bg-neutral-950">
      <div className="flex items-center gap-2 border-b border-neutral-300 bg-neutral-100 p-2 dark:border-neutral-700 dark:bg-neutral-900">
        <button
          className={`rounded px-2 py-1 text-sm font-medium ${penMode ? 'bg-accent text-white' : 'hover:bg-neutral-200 dark:hover:bg-neutral-700'}`}
          onClick={() => setPenMode((v) => !v)}
          title={t('canvas.penModeHint')}
        >
          ✏️ {t('canvas.penMode')}
        </button>
        <button
          className="rounded px-2 py-1 text-sm hover:bg-neutral-200 dark:hover:bg-neutral-700"
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙️ {t('canvas.pageSettings')}
        </button>
        {showSettings && (
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1">
              {t('canvas.pageSize')}
              <select
                className="rounded border border-neutral-300 bg-transparent px-1 py-0.5 dark:border-neutral-600"
                value={settings.pageSize}
                onChange={(e) => updateSettings({ pageSize: e.target.value })}
              >
                {Object.entries(PAGE_SIZES).map(([key, v]) => (
                  <option key={key} value={key}>{v.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              {t('canvas.pageStyle')}
              <select
                className="rounded border border-neutral-300 bg-transparent px-1 py-0.5 dark:border-neutral-600"
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
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <div
          ref={containerRefCallback}
          className="relative min-w-0 shadow-xl"
          style={{ aspectRatio: size.ratio, height: '100%', maxWidth: '100%', ...pageBackgroundStyle(settings.pageStyle), touchAction: penMode ? 'none' : 'auto' }}
          onPointerDownCapture={handlePointerDownCapture}
          onPointerMoveCapture={handlePointerMoveCapture}
          onPointerUpCapture={handlePointerUpCapture}
          onPointerLeave={handlePointerUpCapture}
        >
          <Excalidraw
            key={page.id}
            excalidrawAPI={(api) => { excalidrawAPIRef.current = api; }}
            initialData={initialData}
            onChange={handleExcalidrawChange}
            theme="light"
          />
          <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0" />
        </div>
      </div>
    </div>
  );
}
