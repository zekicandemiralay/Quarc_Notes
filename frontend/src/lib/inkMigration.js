// One-time, best-effort conversion of the old hand-rolled perfect-freehand
// stroke format (`[{ points: [{x,y,pressure}], color, size }, ...]`) into
// Excalidraw's scene format, so canvas pages drawn before the Excalidraw
// switchover don't just go blank. Not pixel-perfect (Excalidraw's own
// freedraw rendering options differ slightly from the old raw perfect-freehand
// call), but preserves the shape/position/color of every stroke.

import { strokeToFreedrawElement } from './freehandElement';

export function isLegacyInkFormat(ink) {
  return Array.isArray(ink);
}

export function convertLegacyInk(strokes) {
  return {
    elements: (strokes || []).map(strokeToFreedrawElement),
    appState: { viewBackgroundColor: 'transparent' },
  };
}
