import { getStroke } from 'perfect-freehand';

// Turns perfect-freehand's outline points into a fillable Path2D.
export function strokeToPath2D(points, options) {
  const outline = getStroke(points, options);
  const path = new Path2D();
  if (!outline.length) return path;

  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    path.lineTo(outline[i][0], outline[i][1]);
  }
  path.closePath();
  return path;
}

// Matches Excalidraw's own freedraw rendering options exactly (confirmed by
// reading its source) — including the `easing` curve, which we were missing
// before. Without it, our live preview (plain/linear pressure response) and
// Excalidraw's committed render (eased response) diverge: moderate pressure
// values render visibly thicker under Excalidraw's sin-based easing than
// under our old default, so a stroke that looked right while drawing still
// thickened slightly the instant it was committed.
export const STROKE_OPTIONS = {
  size: 3,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  easing: (t) => Math.sin((t * Math.PI) / 2),
};

export function distanceToStroke(stroke, x, y) {
  let min = Infinity;
  for (const p of stroke.points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < min) min = d;
  }
  return min;
}
