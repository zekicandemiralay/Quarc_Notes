// Hold-to-snap shape recognition for handwriting ("QuickShape").
//
// Draw a stroke and keep the pen still at its end: recognizeShape() turns
// the wobbly stroke into the clean shape it most likely was — a straight
// line, an arc, an open polyline (L / zig-zag), a circle or ellipse, a
// rectangle or square, a triangle, a diamond or another polygon. While the
// pen is still down, adjustShape() lets the user move the shape into place
// (a line's end follows the pen; closed shapes scale/rotate around their
// centre). Pure geometry, no DOM: unit-tested in shapeRecognition.test.js.
//
// Input points are screen-space { x, y } (thresholds are in screen px, so
// recognition behaves the same at every zoom level).

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

function bounds(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function pointSegDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || dist(out[out.length - 1], p) > 0.5) out.push({ x: p.x, y: p.y });
  }
  return out;
}

// n points evenly spaced along the path (removes the effect of drawing
// speed on point density, which would otherwise bias every fit below).
function resample(pts, n) {
  const total = pathLength(pts);
  if (total === 0) return [pts[0]];
  const step = total / (n - 1);
  const out = [{ ...pts[0] }];
  let acc = 0;
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    let cur = pts[i];
    let d = dist(prev, cur);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const q = { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) };
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, n);
}

// Ramer–Douglas–Peucker: indices of the points that keep the path within eps.
function rdpIndices(pts, eps, first = 0, last = pts.length - 1, out = new Set([0, pts.length - 1])) {
  let maxD = -1;
  let idx = -1;
  for (let i = first + 1; i < last; i++) {
    const d = pointSegDist(pts[i], pts[first], pts[last]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps && idx > 0) {
    out.add(idx);
    rdpIndices(pts, eps, first, idx, out);
    rdpIndices(pts, eps, idx, last, out);
  }
  return out;
}

function interiorAngle(prev, cur, next) {
  const a1 = Math.atan2(prev.y - cur.y, prev.x - cur.x);
  const a2 = Math.atan2(next.y - cur.y, next.x - cur.x);
  let d = Math.abs(a1 - a2);
  if (d > Math.PI) d = TAU - d;
  return d; // PI = straight through
}

function meanDistToPolyline(pts, poly, closed) {
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    const segs = closed ? poly.length : poly.length - 1;
    for (let i = 0; i < segs; i++) {
      const d = pointSegDist(p, poly[i], poly[(i + 1) % poly.length]);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / pts.length;
}

// Principal axis of a point cloud: centroid + direction angle.
function principalAxis(pts) {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return { cx, cy, angle: 0.5 * Math.atan2(2 * sxy, sxx - syy), sxx, syy };
}

function rotate(p, c, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function lineIntersection(p1, d1, p2, d2) {
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

// Snaps an angle to the nearest multiple of `step` if within `tol`.
function snapAngle(angle, step, tol) {
  const k = Math.round(angle / step);
  return Math.abs(angle - k * step) <= tol ? k * step : angle;
}

// ---------- open strokes ----------

function fitLine(pts) {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = dist(a, b);
  if (chord < 1) return null;
  let maxDev = 0;
  let sumDev = 0;
  for (const p of pts) {
    const d = pointSegDist(p, a, b);
    sumDev += d;
    if (d > maxDev) maxDev = d;
  }
  const mean = sumDev / pts.length;
  if (maxDev / chord < 0.08 || (mean / chord < 0.035 && maxDev / chord < 0.13)) {
    return { type: 'line', points: [a, b] };
  }
  return null;
}

// Algebraic (Kåsa) circle fit.
function fitCircle(pts) {
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  const n = pts.length;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
    sxz += p.x * z;
    syz += p.y * z;
    sz += z;
  }
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [D E F]^T = -[sxz syz sz]^T
  const m = [
    [sxx, sxy, sx, -sxz],
    [sxy, syy, sy, -syz],
    [sx, sy, n, -sz],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k];
    }
  }
  const D = m[0][3] / m[0][0];
  const E = m[1][3] / m[1][1];
  const F = m[2][3] / m[2][2];
  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!(r2 > 0)) return null;
  return { cx, cy, r: Math.sqrt(r2) };
}

function fitArc(pts, diag) {
  const c = fitCircle(pts);
  if (!c || c.r > 4 * diag) return null; // nearly straight: not an arc
  let err = 0;
  for (const p of pts) err += Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r);
  err /= pts.length;
  if (err / c.r > 0.06) return null;
  // Sweep: accumulate the signed angle travelled around the centre.
  let sweep = 0;
  let prevA = Math.atan2(pts[0].y - c.cy, pts[0].x - c.cx);
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - c.cy, pts[i].x - c.cx);
    let d = a - prevA;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    sweep += d;
    prevA = a;
  }
  if (Math.abs(sweep) < 25 * DEG || Math.abs(sweep) > 300 * DEG) return null;
  const startA = Math.atan2(pts[0].y - c.cy, pts[0].x - c.cx);
  const midA = startA + sweep / 2;
  const mid = { x: c.cx + c.r * Math.cos(midA), y: c.cy + c.r * Math.sin(midA) };
  return { type: 'arc', points: [pts[0], mid, pts[pts.length - 1]] };
}

function fitPolyline(pts, len) {
  const keep = [...rdpIndices(pts, Math.max(5, 0.045 * len))].sort((a, b) => a - b);
  let verts = keep.map((i) => pts[i]);
  // Drop nearly-straight interior vertices.
  let changed = true;
  while (changed && verts.length > 2) {
    changed = false;
    for (let i = 1; i < verts.length - 1; i++) {
      if (interiorAngle(verts[i - 1], verts[i], verts[i + 1]) > 160 * DEG) {
        verts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (verts.length < 3 || verts.length > 6) return null;
  for (let i = 1; i < verts.length; i++) if (dist(verts[i - 1], verts[i]) < 0.08 * len) return null;
  if (meanDistToPolyline(pts, verts, false) / len > 0.012) return null;
  // Every side straight on its own, and every bend a real corner — a
  // smooth curve (an "S", a wave) approximated by a few segments fails both.
  const vertIdx = verts.map((v) => pts.indexOf(v));
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1];
    const b = verts[i];
    const segLen = dist(a, b);
    let maxDev = 0;
    for (let k = vertIdx[i - 1]; k <= vertIdx[i]; k++) maxDev = Math.max(maxDev, pointSegDist(pts[k], a, b));
    if (maxDev / segLen > 0.06) return null;
  }
  for (let i = 1; i < verts.length - 1; i++) {
    // Direction just before vs. just after the vertex (a few samples away):
    // a sharp corner turns there, a smooth curve turns gradually.
    const k = vertIdx[i];
    const before = pts[Math.max(0, k - 3)];
    const after = pts[Math.min(pts.length - 1, k + 3)];
    const turnLocal = Math.PI - interiorAngle(before, pts[k], after);
    const turnTotal = Math.PI - interiorAngle(verts[i - 1], verts[i], verts[i + 1]);
    if (turnLocal < turnTotal * 0.5) return null;
  }
  return { type: 'polyline', points: verts };
}

// ---------- closed strokes ----------

function fitEllipse(pts) {
  const { angle } = principalAxis(pts);
  const c0 = { x: 0, y: 0 };
  const local = pts.map((p) => rotate(p, c0, -angle));
  const b = bounds(local);
  const rx = b.w / 2;
  const ry = b.h / 2;
  if (rx < 1 || ry < 1) return null;
  const centerLocal = { x: b.minX + rx, y: b.minY + ry };
  let err = 0;
  for (const p of local) {
    const dx = p.x - centerLocal.x;
    const dy = p.y - centerLocal.y;
    const r = Math.hypot(dx / rx, dy / ry);
    if (r > 0) err += Math.abs(1 - 1 / r) * Math.hypot(dx, dy);
  }
  err /= local.length;
  const center = rotate(centerLocal, c0, angle);
  return { shape: { type: 'ellipse', cx: center.x, cy: center.y, rx, ry, angle }, err };
}

function regularizeEllipse(e) {
  let { rx, ry, angle } = e;
  if (Math.min(rx, ry) / Math.max(rx, ry) > 0.85) {
    const r = (rx + ry) / 2;
    return { ...e, rx: r, ry: r, angle: 0, circle: true };
  }
  // Snap a nearly axis-aligned ellipse straight.
  angle = ((angle % Math.PI) + Math.PI) % Math.PI;
  if (angle < 10 * DEG || angle > 170 * DEG) angle = 0;
  else if (Math.abs(angle - Math.PI / 2) < 10 * DEG) {
    [rx, ry] = [ry, rx];
    angle = 0;
  }
  return { ...e, rx, ry, angle };
}

// Corners of a closed loop: RDP from the point farthest from the centroid,
// then each corner is refined by intersecting least-squares lines fitted
// to the two sides meeting there (so rounded, hurried corners still give
// sharp, accurate vertices).
function closedCorners(loop, diag) {
  const { cx, cy } = principalAxis(loop);
  let start = 0;
  let best = -1;
  loop.forEach((p, i) => {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > best) {
      best = d;
      start = i;
    }
  });
  const ring = [...loop.slice(start), ...loop.slice(0, start), loop[start]];
  let idx = [...rdpIndices(ring, 0.055 * diag)].sort((a, b) => a - b);
  idx.pop(); // closing duplicate
  let changed = true;
  while (changed && idx.length > 3) {
    changed = false;
    for (let i = 0; i < idx.length; i++) {
      const prev = ring[idx[(i - 1 + idx.length) % idx.length]];
      const cur = ring[idx[i]];
      const next = ring[idx[(i + 1) % idx.length]];
      if (interiorAngle(prev, cur, next) > 155 * DEG || dist(prev, cur) < 0.12 * diag) {
        idx.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  const n = idx.length;
  if (n < 3) return null;
  const ringLen = ring.length - 1;
  // Fit a line to the middle 60% of each side.
  const sides = [];
  for (let i = 0; i < n; i++) {
    const a = idx[i];
    const b = i + 1 < n ? idx[i + 1] : idx[0] + ringLen;
    const span = b - a;
    const from = Math.round(a + span * 0.2);
    const to = Math.round(b - span * 0.2);
    const seg = [];
    for (let k = from; k <= to; k++) seg.push(ring[k % ringLen]);
    if (seg.length < 2) seg.push(ring[a % ringLen], ring[b % ringLen]);
    const ax = principalAxis(seg);
    sides.push({ p: { x: ax.cx, y: ax.cy }, d: { x: Math.cos(ax.angle), y: Math.sin(ax.angle) } });
  }
  const corners = [];
  for (let i = 0; i < n; i++) {
    const s1 = sides[(i - 1 + n) % n];
    const s2 = sides[i];
    const hit = lineIntersection(s1.p, s1.d, s2.p, s2.d);
    const raw = ring[idx[i]];
    corners.push(hit && dist(hit, raw) < 0.25 * diag ? hit : { x: raw.x, y: raw.y });
  }
  return corners;
}

function regularizePolygon(corners) {
  if (corners.length === 4) {
    const angles = corners.map((c, i) => interiorAngle(corners[(i + 3) % 4], c, corners[(i + 1) % 4]));
    if (angles.every((a) => Math.abs(a - Math.PI / 2) < 18 * DEG)) {
      // Rectangle: average side direction (folded to a quarter turn).
      let s = 0;
      let c = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const th = Math.atan2(b.y - a.y, b.x - a.x);
        s += Math.sin(4 * th);
        c += Math.cos(4 * th);
      }
      let angle = Math.atan2(s, c) / 4;
      if (Math.abs(angle) < 8 * DEG) angle = 0;
      const center = principalAxis(corners);
      const ctr = { x: center.cx, y: center.cy };
      const local = corners.map((p) => rotate(p, ctr, -angle));
      const b = bounds(local);
      let w = b.w;
      let h = b.h;
      if (Math.abs(w - h) / Math.max(w, h) < 0.1) w = h = (w + h) / 2;
      const mid = rotate({ x: b.minX + b.w / 2, y: b.minY + b.h / 2 }, ctr, angle);
      return { type: 'rectangle', cx: mid.x, cy: mid.y, w, h, angle };
    }
    // Diamond: corners close to the middles of the bounding box's sides.
    const b = bounds(corners);
    const mids = [
      { x: b.minX + b.w / 2, y: b.minY },
      { x: b.maxX, y: b.minY + b.h / 2 },
      { x: b.minX + b.w / 2, y: b.maxY },
      { x: b.minX, y: b.minY + b.h / 2 },
    ];
    const tol = 0.15 * Math.max(b.w, b.h);
    if (mids.every((m) => corners.some((c) => dist(c, m) < tol))) {
      return { type: 'polygon', points: mids, kind: 'diamond' };
    }
  }
  return { type: 'polygon', points: corners, kind: corners.length === 3 ? 'triangle' : 'polygon' };
}

// ---------- entry points ----------

export function recognizeShape(input) {
  let pts = dedupe(input || []);
  if (pts.length < 4) return null;
  const b = bounds(pts);
  const diag = Math.hypot(b.w, b.h);
  const len = pathLength(pts);
  if (diag < 18 || len < 24) return null;

  // Closed if the end comes back near the start (allowing for overshoot).
  const n = pts.length;
  const head = Math.max(2, Math.floor(n * 0.3));
  const tol = Math.max(0.18 * diag, 10);
  let closed = false;
  if (len > 1.7 * diag) {
    const last = pts[n - 1];
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < head; i++) {
      const d = dist(pts[i], last);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    if (bd < tol) {
      closed = true;
      if (bi > 0) pts = pts.slice(bi); // drop the overshoot
    } else {
      const first = pts[0];
      for (let j = n - 1; j >= n - head; j--) {
        if (dist(pts[j], first) < tol) {
          closed = true;
          pts = pts.slice(0, j + 1);
          break;
        }
      }
    }
  }

  if (!closed) {
    const sample = resample(pts, 64);
    return fitLine(sample) || fitArc(sample, diag) || fitPolyline(sample, len) || null;
  }

  const loop = resample(pts, 72);
  const ell = fitEllipse(loop);
  const corners = closedCorners(loop, diag);
  const polyErr = corners && corners.length <= 6 ? meanDistToPolyline(loop, corners, true) / diag : Infinity;
  const ellErr = ell ? ell.err / diag : Infinity;

  if (corners && corners.length <= 6 && polyErr < 0.03 && polyErr < ellErr * 0.75) return regularizePolygon(corners);
  if (ellErr < 0.06) return regularizeEllipse(ell.shape);
  if (corners && corners.length <= 6 && polyErr < 0.045) return regularizePolygon(corners);
  return null;
}

// Points of a shape's outline (for previewing, hit-testing and erasing).
export function shapeOutline(shape, segments = 72) {
  switch (shape.type) {
    case 'line':
    case 'polyline':
      return shape.points;
    case 'arc': {
      const c = fitCircle(shape.points);
      if (!c) return shape.points;
      const [a, m, e] = shape.points;
      const a0 = Math.atan2(a.y - c.cy, a.x - c.cx);
      const am = Math.atan2(m.y - c.cy, m.x - c.cx);
      const a1 = Math.atan2(e.y - c.cy, e.x - c.cx);
      // Go from a0 to a1 in whichever direction passes through am.
      const norm = (x) => ((x % TAU) + TAU) % TAU;
      const ccw = norm(am - a0) < norm(a1 - a0);
      const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
      const out = [];
      for (let i = 0; i <= 32; i++) {
        const t = a0 + (sweep * i) / 32;
        out.push({ x: c.cx + c.r * Math.cos(t), y: c.cy + c.r * Math.sin(t) });
      }
      return out;
    }
    case 'polygon':
      return [...shape.points, shape.points[0]];
    case 'rectangle': {
      const c = { x: shape.cx, y: shape.cy };
      const hw = shape.w / 2;
      const hh = shape.h / 2;
      const pts = [
        { x: c.x - hw, y: c.y - hh },
        { x: c.x + hw, y: c.y - hh },
        { x: c.x + hw, y: c.y + hh },
        { x: c.x - hw, y: c.y + hh },
      ].map((p) => rotate(p, c, shape.angle));
      return [...pts, pts[0]];
    }
    case 'ellipse': {
      const c = { x: shape.cx, y: shape.cy };
      const out = [];
      for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * TAU;
        out.push(rotate({ x: c.x + shape.rx * Math.cos(t), y: c.y + shape.ry * Math.sin(t) }, c, shape.angle));
      }
      return out;
    }
    default:
      return [];
  }
}

function shapeCenter(shape) {
  if (shape.type === 'ellipse' || shape.type === 'rectangle') return { x: shape.cx, y: shape.cy };
  const b = bounds(shape.points);
  return { x: b.minX + b.w / 2, y: b.minY + b.h / 2 };
}

function transformShape(shape, origin, scale, rot) {
  const map = (p) => {
    const r = rotate(p, origin, rot);
    return { x: origin.x + (r.x - origin.x) * scale, y: origin.y + (r.y - origin.y) * scale };
  };
  if (shape.type === 'ellipse' || shape.type === 'rectangle') {
    const c = map({ x: shape.cx, y: shape.cy });
    const s = { ...shape, cx: c.x, cy: c.y, angle: shape.angle + rot };
    if (shape.type === 'ellipse') return { ...s, rx: shape.rx * scale, ry: shape.ry * scale };
    return { ...s, w: shape.w * scale, h: shape.h * scale };
  }
  return { ...shape, points: shape.points.map(map) };
}

// While the pen stays down after a snap: `base` is the shape as recognized,
// `grab` where the pen was at that moment, `pen` where it is now.
//  - lines, arcs, polylines: the start stays put and the end follows the
//    pen (a line also snaps to horizontal / vertical / 45° when close);
//  - closed shapes: scale (and, except circles, rotate) around the centre.
export function adjustShape(base, grab, pen) {
  if (base.type === 'line') {
    const a = base.points[0];
    const len = dist(a, pen);
    const angle = snapAngle(Math.atan2(pen.y - a.y, pen.x - a.x), Math.PI / 4, 4 * DEG);
    return { ...base, points: [a, { x: a.x + len * Math.cos(angle), y: a.y + len * Math.sin(angle) }] };
  }
  if (base.type === 'arc' || base.type === 'polyline') {
    const a = base.points[0];
    const end = base.points[base.points.length - 1];
    const d0 = dist(a, end);
    if (d0 < 1) return base;
    const scale = dist(a, pen) / d0;
    const rot = Math.atan2(pen.y - a.y, pen.x - a.x) - Math.atan2(end.y - a.y, end.x - a.x);
    return transformShape(base, a, scale, rot);
  }
  const c = shapeCenter(base);
  const d0 = dist(c, grab);
  if (d0 < 4) return base;
  const scale = Math.max(0.05, dist(c, pen) / d0);
  const rot = base.circle ? 0 : Math.atan2(pen.y - c.y, pen.x - c.x) - Math.atan2(grab.y - c.y, grab.x - c.x);
  return transformShape(base, c, scale, rot);
}
