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

export const STROKE_OPTIONS = {
  size: 3,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
};

export function distanceToStroke(stroke, x, y) {
  let min = Infinity;
  for (const p of stroke.points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < min) min = d;
  }
  return min;
}
