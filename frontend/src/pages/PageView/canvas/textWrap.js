// New text boxes wrap instead of running off to the right.
//
// Excalidraw (0.18) makes a text box of a fixed width, whose text wraps onto the next line, only when the text
// tool is dragged. A click (and a double-click on empty paper) starts a single line that grows to the right
// without end. This gives those a width too, from the room on the page around the click (at least a few words
// wide), so the box is limited and the text wraps; its side handles still make it wider or narrower.
//
// The same file is in Quarc Reader (frontend/src/reader/textWrap.js); keep the two alike.
// No Excalidraw import here (the caller passes its mutateElement), so the tests run in plain Node.

const MARGIN = 16; // kept free inside the page's edges (scene px)
const MIN_EM = 8; // narrowest box, in font sizes (a few words)

/**
 * The box for new text clicked at `x` on a page spanning `left`..`right`: left-aligned text runs from the click to
 * the right edge, right-aligned text from the left edge to the click, centred text is centred on the click. Never
 * narrower than a few words. Returns { x, width }.
 */
export function textBox(x, align, { left, right }, fontSize = 20) {
  const min = MIN_EM * fontSize;
  if (align === 'center') {
    const half = Math.max(Math.min(x - left, right - x) - MARGIN, min / 2);
    return { x: Math.round(x - half), width: Math.round(2 * half) };
  }
  if (align === 'right') {
    const width = Math.max(x - left - MARGIN, min);
    return { x: Math.round(x - width), width: Math.round(width) };
  }
  return { x: Math.round(x), width: Math.round(Math.max(right - x - MARGIN, min)) };
}

/** What is on screen, in scene coordinates (for a click that is not on a page). */
function visibleArea(appState) {
  const left = -appState.scrollX;
  return { left, right: left + appState.width / appState.zoom.value };
}

/**
 * Starts wrapping new text boxes in this Excalidraw. `pageAt(x, y)` gives the horizontal extent { left, right }
 * (scene x) of the page under a scene point, or null when the point is not on a page; `mutateElement` is
 * Excalidraw's. Returns a function that stops it.
 */
export function wrapNewText(api, { pageAt, mutateElement }) {
  const done = new Set(); // text elements already looked at (a box is only ever sized when it is new)

  const size = (el, appState) => {
    const box = textBox(el.x, el.textAlign, pageAt(el.x, el.y) ?? visibleArea(appState), el.fontSize);
    mutateElement(el, { autoResize: false, ...box });
  };

  // A click with the text tool: the box is still being made ("newElement") when the pointer goes up, and
  // Excalidraw decides right after this whether it wraps. A box dragged out wide enough already wraps
  // (autoResize false) and keeps the width it was dragged to.
  const offUp = api.onPointerUp(() => {
    const st = api.getAppState();
    const el = st.newElement;
    if (!el || el.type !== 'text' || el.containerId || el.autoResize === false) return;
    done.add(el.id);
    size(el, st);
  });

  // A double-click on empty paper opens a new, empty text box at once. Its editor was made for one long line,
  // so it is told to wrap as well.
  const offChange = api.onChange((elements, appState) => {
    const editing = appState.editingTextElement;
    if (!editing || appState.newElement || done.has(editing.id)) return;
    done.add(editing.id);
    const el = elements.find((e) => e.id === editing.id);
    if (!el || el.type !== 'text' || el.containerId || !el.autoResize || el.text) return;
    size(el, appState);
    const editor = typeof document !== 'undefined' ? document.querySelector('textarea.excalidraw-wysiwyg') : null;
    if (editor) Object.assign(editor.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
  });

  return () => {
    offUp?.();
    offChange?.();
  };
}
