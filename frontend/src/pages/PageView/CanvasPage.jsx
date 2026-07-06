import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { strokeToPath2D, STROKE_OPTIONS, distanceToStroke } from '../../lib/freehand';

export default function CanvasPage({ page, onChange }) {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [strokes, setStrokes] = useState(page.ink_json || []);
  const [redoStack, setRedoStack] = useState([]);
  const [tool, setTool] = useState('pen');
  const drawing = useRef(null);
  const saveTimer = useRef(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1f2937';
    for (const stroke of strokes) {
      const path = strokeToPath2D(
        stroke.points.map((p) => [p.x, p.y, p.pressure]),
        { ...STROKE_OPTIONS, size: stroke.size || 3 }
      );
      ctx.fillStyle = stroke.color || '#1f2937';
      ctx.fill(path);
    }
    if (drawing.current && !drawing.current.erasing) {
      const path = strokeToPath2D(
        drawing.current.points.map((p) => [p.x, p.y, p.pressure]),
        { ...STROKE_OPTIONS, size: drawing.current.size }
      );
      ctx.fillStyle = drawing.current.color;
      ctx.fill(path);
    }
  }, [strokes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.getContext('2d').scale(dpr, dpr);
    redraw();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    redraw();
  }, [strokes, redraw]);

  function scheduleSave(next) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onChange(next), 500);
  }

  function getPoint(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pointerType === 'pen' ? e.pressure : 0.5,
    };
  }

  function handlePointerDown(e) {
    canvasRef.current.setPointerCapture(e.pointerId);
    const point = getPoint(e);

    if (tool === 'eraser') {
      drawing.current = { erasing: true };
      return;
    }

    drawing.current = {
      points: [point],
      color: '#1f2937',
      size: 3,
      simulatePressure: e.pointerType !== 'pen',
    };
  }

  function handlePointerMove(e) {
    if (!drawing.current) return;
    const point = getPoint(e);

    if (drawing.current.erasing) {
      const next = strokes.filter((s) => distanceToStroke(s, point.x, point.y) > 12);
      if (next.length !== strokes.length) {
        setStrokes(next);
        scheduleSave(next);
      }
      return;
    }

    drawing.current.points.push(point);
    redraw();
  }

  function handlePointerUp() {
    if (!drawing.current) return;
    if (!drawing.current.erasing && drawing.current.points.length > 1) {
      const next = [...strokes, drawing.current];
      setStrokes(next);
      setRedoStack([]);
      scheduleSave(next);
    }
    drawing.current = null;
    redraw();
  }

  function undo() {
    if (!strokes.length) return;
    const next = strokes.slice(0, -1);
    setRedoStack((r) => [strokes[strokes.length - 1], ...r]);
    setStrokes(next);
    scheduleSave(next);
  }

  function redo() {
    if (!redoStack.length) return;
    const [first, ...rest] = redoStack;
    const next = [...strokes, first];
    setRedoStack(rest);
    setStrokes(next);
    scheduleSave(next);
  }

  function clearAll() {
    setStrokes([]);
    setRedoStack([]);
    scheduleSave([]);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-2 border-b border-neutral-200 p-2 dark:border-neutral-700">
        <button
          className={`rounded px-2 py-1 text-sm ${tool === 'pen' ? 'bg-accent text-white' : 'hover:bg-neutral-200 dark:hover:bg-neutral-700'}`}
          onClick={() => setTool('pen')}
        >
          ✏️ {t('canvas.pen')}
        </button>
        <button
          className={`rounded px-2 py-1 text-sm ${tool === 'eraser' ? 'bg-accent text-white' : 'hover:bg-neutral-200 dark:hover:bg-neutral-700'}`}
          onClick={() => setTool('eraser')}
        >
          🧹 {t('canvas.eraser')}
        </button>
        <button className="rounded px-2 py-1 text-sm hover:bg-neutral-200 dark:hover:bg-neutral-700" onClick={undo}>
          ↶ {t('canvas.undo')}
        </button>
        <button className="rounded px-2 py-1 text-sm hover:bg-neutral-200 dark:hover:bg-neutral-700" onClick={redo}>
          ↷ {t('canvas.redo')}
        </button>
        <button className="rounded px-2 py-1 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950" onClick={clearAll}>
          {t('canvas.clear')}
        </button>
      </div>
      <div ref={containerRef} className="relative flex-1 touch-none bg-white dark:bg-neutral-100">
        <canvas
          ref={canvasRef}
          className="absolute inset-0"
          style={{ touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />
      </div>
    </div>
  );
}
