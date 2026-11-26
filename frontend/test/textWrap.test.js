// New text boxes wrap within the page (src/pages/PageView/canvas/textWrap.js; the same as Quarc Reader's), with a stand-in for Excalidraw's API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textBox, wrapNewText } from '../src/pages/PageView/canvas/textWrap.js';

// The bits of Excalidraw's API the helper uses: pointer-up and change listeners, the app state, mutateElement.
function fakeExcalidraw(appState = {}) {
  const ups = [];
  const changes = [];
  const state = { width: 1000, scrollX: 0, zoom: { value: 1 }, newElement: null, editingTextElement: null, ...appState };
  const api = {
    getAppState: () => state,
    onPointerUp: (cb) => (ups.push(cb), () => ups.splice(ups.indexOf(cb), 1)),
    onChange: (cb) => (changes.push(cb), () => changes.splice(changes.indexOf(cb), 1)),
  };
  const mutateElement = (el, updates) => Object.assign(el, updates);
  return {
    api,
    state,
    mutateElement,
    pointerUp: () => ups.forEach((cb) => cb()),
    change: (elements) => changes.forEach((cb) => cb(elements, state)),
    listeners: () => ups.length + changes.length,
  };
}

const text = (props) => ({ id: 't1', type: 'text', x: 100, y: 100, width: 0, fontSize: 20, textAlign: 'left', text: '', autoResize: true, containerId: null, ...props });
// One page from x 0 to 800, y 0 to 1000; nothing else is a page.
const pageAt = (x, y) => (x >= 0 && x <= 800 && y >= 0 && y <= 1000 ? { left: 0, right: 800 } : null);
const PAGE = { left: 0, right: 800 };

test('left-aligned: from the click to the page edge, at least a few words', () => {
  assert.deepEqual(textBox(100, 'left', PAGE, 20), { x: 100, width: 800 - 100 - 16 });
  assert.deepEqual(textBox(750, 'left', PAGE, 20), { x: 750, width: 160 }); // near the edge: 8 font sizes
  assert.deepEqual(textBox(750, 'left', PAGE, 40), { x: 750, width: 320 });
  assert.deepEqual(textBox(300, undefined, PAGE), { x: 300, width: 484 }); // no alignment given: left
});

test('centred: centred on the click; right-aligned: ending at the click', () => {
  assert.deepEqual(textBox(300, 'center', PAGE, 20), { x: 16, width: 568 }); // nearer the left edge: 300 - 16 each side
  assert.deepEqual(textBox(600, 'center', PAGE, 20), { x: 416, width: 368 }); // nearer the right edge
  assert.deepEqual(textBox(790, 'center', PAGE, 20), { x: 710, width: 160 }); // at the edge: still a few words wide
  assert.deepEqual(textBox(500, 'right', PAGE, 20), { x: 16, width: 484 });
  assert.deepEqual(textBox(50, 'right', PAGE, 20), { x: -110, width: 160 });
});

test('a click with the text tool on a page makes a box that wraps at the page edge', () => {
  const x = fakeExcalidraw();
  wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  const el = text();
  x.state.newElement = el;
  x.pointerUp();
  assert.equal(el.autoResize, false);
  assert.equal(el.x, 100);
  assert.equal(el.width, 800 - 100 - 16);
});

test('a centred click is centred on where it was clicked', () => {
  const x = fakeExcalidraw();
  wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  const el = text({ x: 400, textAlign: 'center' });
  x.state.newElement = el;
  x.pointerUp();
  assert.equal(el.x + el.width / 2, 400);
  assert.equal(el.width, 2 * (400 - 16));
});

test('off the page, the box stays within what is on screen', () => {
  const x = fakeExcalidraw({ width: 1200, scrollX: -100, zoom: { value: 2 } }); // visible scene x: 100 .. 700
  wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  const el = text({ x: 300, y: 2000 });
  x.state.newElement = el;
  x.pointerUp();
  assert.equal(el.width, 700 - 300 - 16);
});

test('a box dragged out keeps its width; text in a shape and other tools are left alone', () => {
  const x = fakeExcalidraw();
  wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  const dragged = text({ width: 240, autoResize: false });
  x.state.newElement = dragged;
  x.pointerUp();
  assert.equal(dragged.width, 240);
  const inShape = text({ id: 't2', containerId: 'r1' });
  x.state.newElement = inShape;
  x.pointerUp();
  assert.equal(inShape.autoResize, true);
  const line = { id: 'l1', type: 'line', x: 0, y: 0, width: 5 };
  x.state.newElement = line;
  x.pointerUp();
  assert.equal(line.width, 5);
});

test('a double-click on empty paper (a new, empty box opened at once) wraps too', () => {
  const x = fakeExcalidraw();
  wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  const el = text({ x: 200 });
  x.state.editingTextElement = { id: el.id };
  x.change([el]);
  assert.equal(el.autoResize, false);
  assert.equal(el.width, 800 - 200 - 16);
});

test('editing existing text never changes its box', () => {
  const x = fakeExcalidraw();
  wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  const old = text({ text: 'hello', width: 55 });
  x.state.editingTextElement = { id: old.id };
  x.change([old]);
  assert.equal(old.autoResize, true);
  assert.equal(old.width, 55);
  // ... nor later, once it was looked at, even if it were emptied.
  old.text = '';
  x.change([old]);
  assert.equal(old.width, 55);
});

test('a box from a click is sized once: the change that follows leaves it alone', () => {
  const x = fakeExcalidraw();
  wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  const el = text();
  x.state.newElement = el;
  x.state.editingTextElement = { id: el.id };
  x.change([el]); // while being made: not yet
  assert.equal(el.autoResize, true);
  x.pointerUp();
  x.state.newElement = null;
  el.width = 300; // the person resized it
  x.change([el]);
  assert.equal(el.width, 300);
});

test('stopping removes both listeners', () => {
  const x = fakeExcalidraw();
  const stop = wrapNewText(x.api, { pageAt, mutateElement: x.mutateElement });
  assert.equal(x.listeners(), 2);
  stop();
  assert.equal(x.listeners(), 0);
});

test("Notes' sheets: the extent of the sheet under a point, none on the desk", async () => {
  const { sheetEdgesAt, sheetDims, sheetTop, PAGE_GAP } = await import('../src/pages/PageView/canvas/notebook.js');
  const s = { pageSize: 'A5', orientation: 'portrait', pageCount: 2 };
  const { width, height } = sheetDims(s);
  assert.deepEqual(sheetEdgesAt(10, 10, s), { left: 0, right: width });
  assert.deepEqual(sheetEdgesAt(10, sheetTop(1, { width, height }) + 5, s), { left: 0, right: width }); // the second sheet
  assert.equal(sheetEdgesAt(-5, 10, s), null); // left of the paper
  assert.equal(sheetEdgesAt(width + 5, 10, s), null); // right of it
  assert.equal(sheetEdgesAt(10, height + PAGE_GAP / 4, s), null); // the gap between sheets
  const wide = { ...s, orientation: 'landscape' };
  assert.deepEqual(sheetEdgesAt(10, 10, wide), { left: 0, right: sheetDims(wide).width });
});
