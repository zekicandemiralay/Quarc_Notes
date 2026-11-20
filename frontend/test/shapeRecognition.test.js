// Run: npm test (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape, adjustShape, shapeOutline } from '../src/lib/shapeRecognition.js';

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Makes an ideal path look hand-drawn: uneven speed (irregular spacing),
// a slow wobble, and per-point jitter, all scaled to the shape's size.
function handDrawn(path, { seed = 1, size = 200, jitter = 0.008, wobble = 0.012 } = {}) {
  const r = rng(seed);
  const out = [];
  const phase = r() * Math.PI * 2;
  let t = 0;
  while (t <= 1) {
    const p = path(t);
    const w = Math.sin(t * Math.PI * 3 + phase) * wobble * size;
    out.push({ x: p.x + (r() - 0.5) * 2 * jitter * size + w, y: p.y + (r() - 0.5) * 2 * jitter * size - w });
    t += 0.004 + r() * 0.012; // uneven speed
  }
  out.push(path(1));
  return out;
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function polyPath(pts, closed) {
  const verts = closed ? [...pts, pts[0]] : pts;
  const segs = [];
  let total = 0;
  for (let i = 1; i < verts.length; i++) {
    const len = Math.hypot(verts[i].x - verts[i - 1].x, verts[i].y - verts[i - 1].y);
    segs.push({ a: verts[i - 1], b: verts[i], len });
    total += len;
  }
  return (t) => {
    let d = t * total;
    for (const s of segs) {
      if (d <= s.len) return lerp(s.a, s.b, d / s.len);
      d -= s.len;
    }
    return verts[verts.length - 1];
  };
}

// Rounded corners: what a quickly drawn rectangle really looks like.
function roundedRectPath(x, y, w, h, r) {
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return polyPath(pts, true);
}

const ellipsePath = (cx, cy, rx, ry, rot = 0, from = 0, sweep = Math.PI * 2) => (t) => {
  const a = from + sweep * t;
  const x = rx * Math.cos(a);
  const y = ry * Math.sin(a);
  return { x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) };
};

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

for (let seed = 1; seed <= 6; seed++) {
  test(`straight lines snap to a line (seed ${seed})`, () => {
    for (const [a, b] of [
      [{ x: 10, y: 10 }, { x: 300, y: 40 }],
      [{ x: 50, y: 300 }, { x: 60, y: 20 }],
      [{ x: 0, y: 0 }, { x: 120, y: 120 }],
    ]) {
      const s = recognizeShape(handDrawn(polyPath([a, b], false), { seed, size: 250, wobble: 0.01 }));
      assert.equal(s?.type, 'line', JSON.stringify(s));
      near(s.points[0].x, a.x, 12, 'start x');
      near(s.points[1].y, b.y, 12, 'end y');
    }
  });

  test(`circles snap to a circle (seed ${seed})`, () => {
    // With a 20° overshoot past the start, as people really draw them.
    const s = recognizeShape(handDrawn(ellipsePath(200, 200, 80, 80, 0, 0.3, Math.PI * 2 + 0.35), { seed, size: 160 }));
    assert.equal(s?.type, 'ellipse', JSON.stringify(s));
    assert.ok(s.circle, 'should be regularized to a circle');
    near(s.cx, 200, 8, 'cx');
    near(s.rx, 80, 10, 'r');
  });

  test(`ellipses snap to a (rotated) ellipse (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(ellipsePath(300, 200, 140, 60, 0.5), { seed, size: 200 }));
    assert.equal(s?.type, 'ellipse', JSON.stringify(s));
    assert.ok(!s.circle);
    near(Math.max(s.rx, s.ry) / Math.min(s.rx, s.ry), 140 / 60, 0.45, 'aspect');
  });

  test(`rectangles (rounded, hurried corners) snap to a rectangle (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(roundedRectPath(50, 60, 260, 140, 14), { seed, size: 200 }));
    assert.equal(s?.type, 'rectangle', JSON.stringify(s));
    near(s.angle, 0, 0.001, 'axis-aligned');
    near(s.w, 260, 22, 'w');
    near(s.h, 140, 22, 'h');
  });

  test(`squares become exact squares (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(polyPath([{ x: 0, y: 0 }, { x: 150, y: 4 }, { x: 146, y: 152 }, { x: -3, y: 148 }], true), { seed, size: 150 }));
    assert.equal(s?.type, 'rectangle', JSON.stringify(s));
    assert.equal(s.w, s.h);
  });

  test(`triangles snap to a triangle (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(polyPath([{ x: 100, y: 0 }, { x: 200, y: 170 }, { x: 0, y: 170 }], true), { seed, size: 200 }));
    assert.equal(s?.type, 'polygon', JSON.stringify(s));
    assert.equal(s.points.length, 3);
  });

  test(`L-shapes snap to a polyline (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(polyPath([{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 160, y: 200 }], false), { seed, size: 200, wobble: 0.006 }));
    assert.equal(s?.type, 'polyline', JSON.stringify(s));
    assert.equal(s.points.length, 3);
  });

  test(`arcs snap to an arc (seed ${seed})`, () => {
    const s = recognizeShape(handDrawn(ellipsePath(200, 200, 120, 120, 0, Math.PI, Math.PI * 0.8), { seed, size: 200, wobble: 0.006 }));
    assert.equal(s?.type, 'arc', JSON.stringify(s));
  });
}

test('rotated rectangles keep their rotation', () => {
  const a = 0.6;
  const c = { x: 200, y: 200 };
  const rot = (p) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) });
  const pts = [{ x: 100, y: 150 }, { x: 300, y: 150 }, { x: 300, y: 250 }, { x: 100, y: 250 }].map(rot);
  const s = recognizeShape(handDrawn(polyPath(pts, true), { seed: 3, size: 200 }));
  assert.equal(s?.type, 'rectangle');
  const ang = ((s.angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  near(Math.min(ang, Math.PI / 2 - ang), Math.min(a, Math.PI / 2 - a), 0.12, 'angle');
});

test('a rhombus is recognized as a diamond; a square diamond as a rotated square', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const s = recognizeShape(handDrawn(polyPath([{ x: 130, y: 0 }, { x: 260, y: 80 }, { x: 130, y: 160 }, { x: 0, y: 80 }], true), { seed, size: 200 }));
    assert.equal(s?.type, 'polygon', JSON.stringify(s));
    assert.equal(s.kind, 'diamond');
    const sq = recognizeShape(handDrawn(polyPath([{ x: 100, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 200 }, { x: 0, y: 100 }], true), { seed, size: 200 }));
    assert.equal(sq?.type, 'rectangle', JSON.stringify(sq));
    assert.equal(sq.w, sq.h);
    near(Math.abs(sq.angle), Math.PI / 4, 0.1, 'rotated 45°');
  }
});

test('handwriting does not snap to shapes', () => {
  // An "S", a scribble, a spiral, a cursive "e"-like loop chain, and a tiny dot.
  const sCurve = (t) => ({ x: 100 + 60 * Math.sin(t * Math.PI * 2), y: 20 + 160 * t });
  const scribble = (t) => ({ x: 200 * t, y: 40 * Math.sin(t * Math.PI * 9) });
  const spiral = (t) => ({ x: 150 + 20 * (1 + 4 * t) * Math.cos(t * Math.PI * 6), y: 150 + 20 * (1 + 4 * t) * Math.sin(t * Math.PI * 6) });
  const loops = (t) => ({ x: 300 * t + 25 * Math.cos(t * Math.PI * 10), y: 25 * Math.sin(t * Math.PI * 10) });
  for (const [name, path] of Object.entries({ sCurve, scribble, spiral, loops })) {
    for (let seed = 1; seed <= 4; seed++) {
      const s = recognizeShape(handDrawn(path, { seed, size: 150, wobble: 0.004 }));
      assert.equal(s, null, `${name} (seed ${seed}) snapped to ${JSON.stringify(s)}`);
    }
  }
  assert.equal(recognizeShape([{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 3 }, { x: 4, y: 2 }]), null);
});

test('adjusting a line: the end follows the pen and snaps to 45° steps', () => {
  const line = { type: 'line', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
  const moved = adjustShape(line, { x: 100, y: 0 }, { x: 200, y: 50 });
  near(moved.points[1].x, 200, 0.01, 'free end x');
  near(moved.points[1].y, 50, 0.01, 'free end y');
  const snapped = adjustShape(line, { x: 100, y: 0 }, { x: 200, y: 6 }); // 1.7° off horizontal
  near(snapped.points[1].y, 0, 1e-9, 'snapped to horizontal');
  near(snapped.points[0].x, 0, 0, 'start fixed');
});

test('adjusting a closed shape scales and rotates around its centre', () => {
  const rect = { type: 'rectangle', cx: 0, cy: 0, w: 100, h: 50, angle: 0 };
  const big = adjustShape(rect, { x: 50, y: 0 }, { x: 100, y: 0 });
  near(big.w, 200, 1e-9, 'scaled w');
  const turned = adjustShape(rect, { x: 50, y: 0 }, { x: 0, y: 50 });
  near(turned.angle, Math.PI / 2, 1e-9, 'rotated');
  const circle = { type: 'ellipse', cx: 0, cy: 0, rx: 50, ry: 50, angle: 0, circle: true };
  near(adjustShape(circle, { x: 50, y: 0 }, { x: 0, y: 80 }).angle, 0, 0, 'circles never rotate');
});

test('outlines are closed for closed shapes', () => {
  for (const s of [
    { type: 'rectangle', cx: 0, cy: 0, w: 10, h: 10, angle: 0 },
    { type: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5, angle: 0 },
    { type: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] },
  ]) {
    const o = shapeOutline(s);
    assert.ok(Math.hypot(o[0].x - o[o.length - 1].x, o[0].y - o[o.length - 1].y) < 1e-9);
  }
});
