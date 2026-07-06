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

// Excalidraw's own freedraw renderer computes perfect-freehand's `size` as
// strokeWidth * 4.25 (confirmed by reading its source). Without accounting
// for that, a stroke that looks right in our live preview renders ~4.25x
// thicker the instant it's committed to the scene.
const EXCALIDRAW_FREEDRAW_SIZE_FACTOR = 4.25;

const PEN_SIZES = [
  { size: 2, dot: 6 },
  { size: 4, dot: 9 },
  { size: 7, dot: 13 },
  { size: 12, dot: 18 },
];

const PEN_COLORS = ['#1f2937', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];

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
  const [showPenOptions, setShowPenOptions] = useState(false);
  // Mirrors Excalidraw's own active tool. Our reliable pressure-capture path
  // only takes over pen input while Excalidraw's own "freedraw" tool is
  // selected — for every other tool (select/shapes/text/eraser), pen input
  // passes straight through to Excalidraw's native handling untouched. This
  // is what makes the eraser (and select/move) work correctly with a stylus.
  const [activeToolType, setActiveToolType] = useState('freedraw');
  const [penSize, setPenSize] = useState(4);
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
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

  function handleExcalidrawChange(_elements, appState) {
    if (appState?.activeTool?.type) setActiveToolType(appState.activeTool.type);
    scheduleSave();
  }

  function handleExcalidrawAPI(api) {
    excalidrawAPIRef.current = api;
    // Pen selected by default — open a fresh drawing ready to write on.
    // Deferred a tick: Excalidraw's own post-mount initialization can
    // otherwise race with (and win over) an immediate call here.
    setTimeout(() => {
      api.setActiveTool({ type: 'freedraw' });
      setActiveToolType('freedraw');
    }, 0);
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

  const isPenActive = activeToolType === 'freedraw';

  // Capture phase on the page container: only ever intercepts real pen input
  // while Excalidraw's own active tool is "freedraw". Touch/mouse pointers,
  // and pen input while any OTHER tool (select/eraser/shapes) is active, are
  // never touched here (no stopPropagation), so they fall through to
  // Excalidraw untouched — that's what gives us native 1-finger pan /
  // 2-finger pinch-zoom, and a working eraser, for free.
  function handlePointerDownCapture(e) {
    if (!isPenActive || e.pointerType !== 'pen') return;
    e.stopPropagation();
    e.preventDefault();
    drawing.current = { pointerId: e.pointerId, points: [getPoint(e)], color: penColor, size: penSize };
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
      size: stroke.size / (EXCALIDRAW_FREEDRAW_SIZE_FACTOR * (appState.zoom?.value || 1)),
      simulatePressure: false,
    });

    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element] });
    scheduleSave();
  }

  const size = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.A5;

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
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <div
          ref={containerRefCallback}
          className={`quarc-canvas-page relative min-w-0 shadow-xl ${isPenActive ? 'quarc-pen-active' : ''}`}
          style={{ aspectRatio: size.ratio, height: '100%', maxWidth: '100%', touchAction: isPenActive ? 'none' : 'auto', ...pageBackgroundStyle(settings.pageStyle) }}
          onPointerDownCapture={handlePointerDownCapture}
          onPointerMoveCapture={handlePointerMoveCapture}
          onPointerUpCapture={handlePointerUpCapture}
          onPointerLeave={handlePointerUpCapture}
        >
          <style>{`
            .quarc-canvas-page.quarc-pen-active .App-menu__left { display: none !important; }
            .quarc-canvas-page .excalidraw { --color-primary: #f59e0b; --color-primary-darker: #d97706; --color-primary-darkest: #b45309; --color-primary-light: #fef3c7; --color-primary-light-darker: #fde68a; --color-primary-hover: #d97706; }
          `}</style>
          <Excalidraw
            key={page.id}
            excalidrawAPI={handleExcalidrawAPI}
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
