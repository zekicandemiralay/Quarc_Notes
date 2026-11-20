// Run: npm test (from frontend/)
// Cut pieces must join without a gap when drawn the way Excalidraw draws
// freedraw: its own bundled perfect-freehand, its exact options, and
// `last: false` (restore() resets lastCommittedPoint on every load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clipPolylineByPolygon, cutOutline, pinCutJoints, densify, END_PINS } from '../src/pages/PageView/canvas/selectionCut.js';

// The copy Excalidraw itself resolves (its nested one if it has one).
const require = createRequire(import.meta.url);
const excalidrawDir = fileURLToPath(new URL('../node_modules/@excalidraw/excalidraw/', import.meta.url));
const { getStroke } = require(require.resolve('perfect-freehand', { paths: [excalidrawDir] }));

const FACTOR = 4.25; // EXCALIDRAW_FREEDRAW_SIZE_FACTOR

// Outline polygon of a piece exactly as Excalidraw renders it.
function render(run, strokeWidth) {
  return getStroke(
    run.map((p) => [p.x, p.y, p.pressure]),
    {
      simulatePressure: false,
      size: strokeWidth * FACTOR,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      easing: (t) => Math.sin((t * Math.PI) / 2),
      last: false,
    }
  );
}

// Nonzero winding, like Excalidraw's fill (perfect-freehand's end cap
// overlaps itself, which even-odd would count as a hole).
function inside(x, y, poly) {
  let winding = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const side = (xi - xj) * (y - yj) - (x - xj) * (yi - yj);
    if (yj <= y) {
      if (yi > y && side > 0) winding++;
    } else if (yi <= y && side < 0) winding--;
  }
  return winding !== 0;
}

// Longest stretch of the path (scene units) that no piece covers — counting
// only where the uncut stroke had ink (`original`), when given: a stroke's
// free end is drawn short of its last point either way.
function longestGap(path, polys, original = null, step = 0.01) {
  let worst = 0;
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const y = a.y + ((b.y - a.y) * k) / n;
      if (polys.some((poly) => inside(x, y, poly)) || (original && !inside(x, y, original))) run = 0;
      else worst = Math.max(worst, (run += Math.hypot(b.x - a.x, b.y - a.y) / n));
    }
  }
  return worst;
}

// A quickly written line at 212% zoom, 2.5px pen: a sample every ~4.7
// scene units (10 screen px), ink ~1.6 units wide.
const ZOOM = 2.12;
const strokeWidth = 2.5 / (FACTOR * ZOOM);
const wavy = [];
for (let x = 0; x <= 400; x += 10 / ZOOM) wavy.push({ x, y: Math.sin(x / 21) * 6, pressure: 0.45 });
// Cut both sides just before a pen sample: the worst case.
const sample = 10 / ZOOM;
const cx1 = sample * 30 - 0.3;
const cx2 = sample * 60 - 0.3;
const rect = [
  { x: cx1, y: -50 },
  { x: cx2, y: -50 },
  { x: cx2, y: 50 },
  { x: cx1, y: 50 },
];
const near = (cx) => wavy.filter((p) => Math.abs(p.x - cx) < 8);

test('the old cut left a gap at both cut points (guards this test)', () => {
  const { insideRuns, outsideRuns } = clipPolylineByPolygon(wavy, rect);
  const polys = [...insideRuns, ...outsideRuns].map((r) => render(r, strokeWidth));
  assert.ok(longestGap(near(cx1), polys) > 0.5, 'left cut gap');
  assert.ok(longestGap(near(cx2), polys) > 0.5, 'right cut gap');
});

test('cut pen-stroke pieces join without a gap', () => {
  const { insideRuns, outsideRuns } = cutOutline(wavy, rect);
  assert.equal(insideRuns.length, 1);
  assert.equal(outsideRuns.length, 2);
  const polys = [...insideRuns, ...outsideRuns].map((r) => render(r, strokeWidth));
  assert.equal(longestGap(near(cx1), polys), 0);
  assert.equal(longestGap(near(cx2), polys), 0);
  // Everywhere else it looks just like the uncut stroke.
  assert.equal(longestGap(wavy, polys, render(wavy, strokeWidth)), 0);
});

test("a pen stroke's own free ends are left exactly as drawn", () => {
  const { outsideRuns } = cutOutline(wavy, rect);
  const last = outsideRuns[1];
  assert.equal(last[last.length - 1], wavy[wavy.length - 1], 'natural end not pinned');
  assert.equal(outsideRuns[0][0], wavy[0], 'natural start untouched');
  // The cut end is pinned.
  const first = outsideRuns[0];
  assert.deepEqual(first.slice(-END_PINS).map((p) => p.x), Array(END_PINS).fill(first[first.length - 1].x));
});

test('a cut straight line keeps its full length on both sides', () => {
  // An Excalidraw line (2 points) 3 units wide, cut in the middle.
  const line = [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 200, y: 0, pressure: 0.5 },
  ];
  const width = 3;
  const sw = width / (FACTOR * 2 * Math.SQRT1_2);
  const cut = [
    { x: 80, y: -20 },
    { x: 120, y: -20 },
    { x: 120, y: 20 },
    { x: 80, y: 20 },
  ];
  const old = clipPolylineByPolygon(line, cut);
  const oldPolys = [...old.insideRuns, ...old.outsideRuns].map((r) => render(r, sw));
  assert.ok(longestGap(line, oldPolys) > 5, 'old: pieces stopped well short');

  const { insideRuns, outsideRuns } = cutOutline(line, cut, { shape: true, step: width / 2 });
  const polys = [...insideRuns, ...outsideRuns].map((r) => render(r, sw));
  assert.equal(longestGap(line, polys), 0);
  // Reaches (within a hair) both of the line's real ends.
  assert.ok(polys.some((p) => inside(0.05, 0, p)) && polys.some((p) => inside(199.95, 0, p)));
});

test('densify keeps the corners and spacing', () => {
  const pts = densify(
    [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 10, y: 0, pressure: 0.5 },
      { x: 10, y: 10, pressure: 0.5 },
    ],
    2
  );
  assert.equal(pts.length, 11);
  assert.ok(pts.some((p) => p.x === 10 && p.y === 0), 'corner kept');
  for (let i = 1; i < pts.length; i++) assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) <= 2 + 1e-9);
});

// Scene elements as an older version stored them after a cut.
function freedraw(id, run, extra = {}) {
  const x = Math.min(...run.map((p) => p.x));
  const y = Math.min(...run.map((p) => p.y));
  return {
    id,
    type: 'freedraw',
    x,
    y,
    points: run.map((p) => [p.x - x, p.y - y]),
    pressures: run.map((p) => p.pressure),
    strokeWidth,
    version: 3,
    versionNonce: 1,
    isDeleted: false,
    ...extra,
  };
}

test('pieces cut by an older version get their gaps closed on load', () => {
  const { insideRuns, outsideRuns } = clipPolylineByPolygon(wavy, rect);
  const els = [freedraw('a', outsideRuns[0]), freedraw('b', insideRuns[0]), freedraw('c', outsideRuns[1]), freedraw('other', wavy.map((p) => ({ ...p, y: p.y + 40 })))];
  const fixed = pinCutJoints(els);
  const byId = Object.fromEntries(fixed.map((e) => [e.id, e]));
  // a and b end at a cut: pinned and version-bumped; c and the unrelated stroke untouched.
  for (const id of ['a', 'b']) {
    assert.equal(byId[id].points.length, els.find((e) => e.id === id).points.length + END_PINS);
    assert.equal(byId[id].pressures.length, byId[id].points.length);
    assert.equal(byId[id].version, 4);
  }
  assert.equal(byId.c, els[2]);
  assert.equal(byId.other, els[3]);
  const toRun = (e) => e.points.map(([px, py], i) => ({ x: e.x + px, y: e.y + py, pressure: e.pressures[i] }));
  const polys = fixed.slice(0, 3).map((e) => render(toRun(e), strokeWidth));
  assert.equal(longestGap(wavy, polys, render(wavy, strokeWidth)), 0);
  // Idempotent: nothing left to repair.
  assert.equal(pinCutJoints(fixed), fixed);
});

test('pinCutJoints leaves deleted, non-freedraw and lone strokes alone', () => {
  const els = [
    freedraw('lone', wavy),
    freedraw('gone', wavy.slice(0, 10), { isDeleted: true }),
    freedraw('next', wavy.slice(9)),
    { id: 'r', type: 'rectangle', x: 0, y: 0, width: 5, height: 5, isDeleted: false },
  ];
  // 'gone' ends where 'next' starts, but it's deleted.
  assert.equal(pinCutJoints(els), els);
  assert.deepEqual(pinCutJoints([]), []);
});
