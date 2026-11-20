import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { shapeOutline } from '../../../lib/shapeRecognition';
import { getCuttableOutline } from './selectionCut';

// Excalidraw renders freedraw with perfect-freehand at size = strokeWidth *
// 4.25 (confirmed in its source), so a stroke previewed at `size` screen px
// is committed with strokeWidth = size / (4.25 * zoom).
export const EXCALIDRAW_FREEDRAW_SIZE_FACTOR = 4.25;

// Visible width (screen px) of a perfect-freehand stroke at a given
// pressure with our STROKE_OPTIONS — measured: 2 * size * ease(0.5 - 0.6 * (0.5 - p)).
export function inkWidth(size, pressure = 0.5) {
  return 2 * size * Math.sin((Math.PI / 2) * (0.5 - 0.6 * (0.5 - pressure)));
}

const TAU = Math.PI * 2;
const normAngle = (a) => ((a % TAU) + TAU) % TAU;

// A recognized shape (screen coords, see lib/shapeRecognition.js) as real
// Excalidraw elements in scene coords — lines, rectangles and ellipses stay
// editable afterwards (drag a line's ends, resize/rotate a rectangle).
// Clean geometry (roughness 0), same colour/width/opacity as the ink.
export function shapeToElements(shape, toScene, style) {
  const common = {
    strokeColor: style.color,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: style.strokeWidth,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: style.opacity ?? 100,
    roundness: null,
  };
  const linear = (pts) => {
    const scene = pts.map(toScene);
    const o = scene[0];
    return { type: 'line', x: o.x, y: o.y, points: scene.map((p) => [p.x - o.x, p.y - o.y]), ...common };
  };
  let skeleton;
  switch (shape.type) {
    case 'line':
    case 'polyline':
      skeleton = linear(shape.points);
      break;
    case 'arc':
      skeleton = linear(shapeOutline(shape).filter((_, i, a) => i % 2 === 0 || i === a.length - 1));
      break;
    case 'polygon':
      skeleton = linear(shapeOutline(shape));
      break;
    case 'rectangle': {
      const c = toScene({ x: shape.cx, y: shape.cy });
      const w = shape.w / style.zoom;
      const h = shape.h / style.zoom;
      skeleton = { type: 'rectangle', x: c.x - w / 2, y: c.y - h / 2, width: w, height: h, angle: normAngle(shape.angle), ...common };
      break;
    }
    case 'ellipse': {
      const c = toScene({ x: shape.cx, y: shape.cy });
      const rx = shape.rx / style.zoom;
      const ry = shape.ry / style.zoom;
      skeleton = { type: 'ellipse', x: c.x - rx, y: c.y - ry, width: 2 * rx, height: 2 * ry, angle: normAngle(shape.angle), ...common };
      break;
    }
    default:
      return [];
  }
  return convertToExcalidrawElements([skeleton], { regenerateIds: true });
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Does an eraser circle (scene coords) touch this element?
export function eraserHits(el, p, radius) {
  if (el.isDeleted || el.locked) return false;
  const pad = radius + (el.strokeWidth || 1) * 2;
  const diag = Math.hypot(el.width || 0, el.height || 0);
  // Cheap reject on a generous box (covers any rotation).
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  if (Math.abs(p.x - cx) > diag / 2 + pad || Math.abs(p.y - cy) > diag / 2 + pad) return false;

  const outline = getCuttableOutline(el);
  if (!outline) {
    // Text, images, ...: anywhere inside the box.
    return p.x >= el.x - radius && p.x <= el.x + el.width + radius && p.y >= el.y - radius && p.y <= el.y + el.height + radius;
  }
  const reach = radius + (el.type === 'freedraw' ? el.strokeWidth * EXCALIDRAW_FREEDRAW_SIZE_FACTOR * 0.5 : (el.strokeWidth || 1) / 2);
  if (outline.length === 1) return Math.hypot(p.x - outline[0].x, p.y - outline[0].y) <= reach;
  for (let i = 1; i < outline.length; i++) {
    if (distToSegment(p, outline[i - 1], outline[i]) <= reach) return true;
  }
  return false;
}
