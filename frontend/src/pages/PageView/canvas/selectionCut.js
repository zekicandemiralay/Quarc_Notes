// Geometry for the MS-Paint-style rectangle/free-form selection tool, which
// literally cuts strokes and shapes at the selection boundary instead of
// selecting whole elements (moved out of CanvasPage.jsx unchanged; the
// eraser reuses getCuttableOutline for hit-testing).

// Standard ray-casting point-in-polygon test.
export function pointInPolygon(x, y, polygon) {
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
export function segmentIntersection(p1, p2, p3, p4) {
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

// Literally cuts a polyline (a freedraw stroke's points, or another
// element's outline — see getCuttableOutline — in scene coordinates, with
// pressure) at every point it crosses the selection polygon's boundary —
// like Microsoft Paint's selection tool cutting through whatever pixels it
// encloses, rather than treating each stroke as an atomic all-or-nothing
// object. Walks every segment and finds every polygon-edge crossing along
// it (sorted by how far along it they fall, so a segment that weaves
// through a concave lasso boundary more than once is still handled
// correctly), splitting the stroke there with a linearly-interpolated
// pressure. Returns the resulting inside/outside pieces as arrays of point
// runs — each run becomes its own new freedraw element.
//
// Crossings are checked on EVERY segment, not only when its two endpoints
// are already on different sides: a freedraw stroke's densely-sampled
// points made that shortcut invisible, but a long, sparse segment — a
// rectangle's edge, a straight two-point line — can dip into the selection
// and back out again entirely between two same-side endpoints, and those
// crossings would otherwise be silently skipped (confirmed: this is exactly
// what made lines/rectangles fall through to "select whole" instead of
// being cut).
export function clipPolylineByPolygon(points, polygon) {
  const insideRuns = [];
  const outsideRuns = [];
  if (points.length === 0) return { insideRuns, outsideRuns };

  let currentInside = pointInPolygon(points[0].x, points[0].y, polygon);
  let currentRun = [points[0]];

  // A point lying exactly on the boundary is crossed twice (end of one
  // segment, start of the next), which yields a zero-length run — a stray
  // dot if kept — so runs without any length are dropped.
  const hasLength = (run) => {
    for (let i = 1; i < run.length; i++) if (Math.abs(run[i].x - run[0].x) > 1e-6 || Math.abs(run[i].y - run[0].y) > 1e-6) return true;
    return false;
  };
  const flush = () => {
    if (currentRun.length > 1 && hasLength(currentRun)) (currentInside ? insideRuns : outsideRuns).push(currentRun);
  };

  for (let i = 1; i < points.length; i++) {
    const p1 = points[i - 1];
    const p2 = points[i];

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
    currentInside = pointInPolygon(p2.x, p2.y, polygon);
  }
  flush();

  return { insideRuns, outsideRuns };
}

// ---------- making cut pieces join seamlessly ----------
//
// Excalidraw draws freedraw through perfect-freehand with `streamline: 0.5`
// and, for every stroke loaded from storage, `last: false` (its restore()
// resets lastCommittedPoint). So a stroke's drawn end trails its last stored
// point by roughly ¾ of the final pen-sample spacing. Nobody sees that at a
// stroke's free end, but at a cut both pieces stopped short of the shared
// cut point: a visible gap at each end of the selection (a few px for a
// quickly written line). Repeating the end point lets the smoothing catch
// up — each repeat closes ~57% of what's left, so after END_PINS repeats the
// end sits on the cut point. Stored in the points themselves, so it holds
// after reloads, on other devices and in older app versions.
export const END_PINS = 10;

export function pinEnd(run, count = END_PINS) {
  const last = run[run.length - 1];
  const out = run.slice();
  for (let i = 0; i < count; i++) out.push({ ...last });
  return out;
}

// A shape's outline (a line's two ends, a rectangle's corners) is far too
// sparse for that smoothing: a 2-point piece is drawn only ~80% of its
// length and corners get rounded off. Evenly spaced samples make a cut
// shape's pieces look like the shape they came from.
export function densify(run, step = 1) {
  const out = [run[0]];
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1];
    const b = run[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t });
    }
    out.push(b);
  }
  return out;
}

// Cuts an element's outline (getCuttableOutline) with the selection polygon
// and prepares every piece to be drawn as freedraw that joins its neighbours
// without a gap. A pen stroke keeps its own samples and only its cut ends
// are pinned (its free ends stay exactly as they were drawn); a shape's
// pieces are resampled (`step` ≈ half the line width keeps corners crisp)
// and pinned at both kinds of end, matching the shape's exact ends.
export function cutOutline(outline, polygon, { shape = false, step = 1 } = {}) {
  const { insideRuns, outsideRuns } = clipPolylineByPolygon(outline, polygon);
  // Not cut at all (wholly inside or outside): the element stays as it is.
  if (!insideRuns.length || !outsideRuns.length) return { insideRuns, outsideRuns };
  const end = outline[outline.length - 1];
  const prepare = (run) => {
    const pts = shape ? densify(run, step) : run;
    return shape || run[run.length - 1] !== end ? pinEnd(pts) : pts;
  };
  return { insideRuns: insideRuns.map(prepare), outsideRuns: outsideRuns.map(prepare) };
}

// Pieces cut by older versions were stored without the pins, so their cut
// ends still stop short. They're recognisable: a cut piece ends exactly
// where another stroke starts (the shared cut point). Pins those ends — a
// version bump, so the repair syncs like any edit. Returns the same array
// when there's nothing to repair; idempotent (a pinned end repeats its last
// point, and those are skipped).
export function pinCutJoints(elements) {
  const live = (el) => el && el.type === 'freedraw' && !el.isDeleted && Array.isArray(el.points) && el.points.length >= 2;
  const cell = (x, y) => `${Math.round(x)}:${Math.round(y)}`;
  const starts = new Map();
  for (const el of elements) {
    if (!live(el)) continue;
    const s = { id: el.id, x: el.x + el.points[0][0], y: el.y + el.points[0][1] };
    const k = cell(s.x, s.y);
    if (!starts.has(k)) starts.set(k, []);
    starts.get(k).push(s);
  }
  const startsAt = (id, x, y) => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const s of starts.get(cell(x + dx, y + dy)) || []) if (s.id !== id && Math.abs(s.x - x) < 1e-3 && Math.abs(s.y - y) < 1e-3) return true;
    return false;
  };
  let changed = false;
  const out = elements.map((el) => {
    if (!live(el)) return el;
    const pts = el.points;
    const [lx, ly] = pts[pts.length - 1];
    const [px, py] = pts[pts.length - 2];
    if ((lx === px && ly === py) || !startsAt(el.id, el.x + lx, el.y + ly)) return el;
    changed = true;
    const pressures = el.pressures?.length === pts.length ? [...el.pressures, ...Array(END_PINS).fill(el.pressures[pts.length - 1])] : el.pressures;
    return {
      ...el,
      points: [...pts, ...Array.from({ length: END_PINS }, () => [lx, ly])],
      pressures,
      version: (el.version || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
  });
  return changed ? out : elements;
}

// For elements with no cuttable outline (text, images, frames, ...), this
// decides whether the selection area touches the element's bounding box at
// all — checked three ways: either shape's corners inside the other shape,
// or any of their edges crossing.
export function boundingBoxIntersectsPolygon(el, polygon) {
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

// Rotates a point around a center by an angle in radians (Excalidraw stores
// element rotation this way — corners/outline samples below are computed
// axis-aligned first, then rotated to match the element's actual angle).
export function rotatePoint(p, cx, cy, angle) {
  if (!angle) return { x: p.x, y: p.y };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// Returns an element's outline as an absolute-coordinate point list — the
// same shape clipPolylineByPolygon already expects for freedraw strokes —
// so a rectangle/diamond/ellipse/line/arrow can be cut exactly like a pen
// stroke instead of only ever being selected whole. freedraw/line/arrow are
// already point sequences (open paths); rectangle/diamond/ellipse aren't
// stored as points at all, so their corners (or, for the ellipse, a sampled
// perimeter) are computed here and the loop is explicitly closed by
// repeating the first point at the end, so a selection that clips through a
// closed shape's edge still produces correct inside/outside arcs. Returns
// null for element types that can't be meaningfully split into "inside"/
// "outside" pieces (text, image, frame, ...) — those fall back to being
// selected whole via boundingBoxIntersectsPolygon.
export function getCuttableOutline(el) {
  if (el.type === 'freedraw') {
    return el.points.map((p, i) => ({ x: el.x + p[0], y: el.y + p[1], pressure: el.pressures?.[i] ?? 0.5 }));
  }
  if (el.type === 'line' || el.type === 'arrow') {
    return el.points.map((p) => ({ x: el.x + p[0], y: el.y + p[1], pressure: 0.5 }));
  }
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  if (el.type === 'rectangle' || el.type === 'diamond') {
    const corners =
      el.type === 'diamond'
        ? [
            { x: cx, y: el.y },
            { x: el.x + el.width, y: cy },
            { x: cx, y: el.y + el.height },
            { x: el.x, y: cy },
          ]
        : [
            { x: el.x, y: el.y },
            { x: el.x + el.width, y: el.y },
            { x: el.x + el.width, y: el.y + el.height },
            { x: el.x, y: el.y + el.height },
          ];
    return [...corners, corners[0]].map((p) => ({ ...rotatePoint(p, cx, cy, el.angle), pressure: 0.5 }));
  }
  if (el.type === 'ellipse') {
    const rx = el.width / 2;
    const ry = el.height / 2;
    const SEGMENTS = 64;
    const points = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2;
      const p = { x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) };
      points.push({ ...rotatePoint(p, cx, cy, el.angle), pressure: 0.5 });
    }
    return points;
  }
  return null;
}
