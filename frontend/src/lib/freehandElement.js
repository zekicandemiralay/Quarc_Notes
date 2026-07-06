// Builds a valid Excalidraw freedraw scene element from a raw stroke
// ({ points: [{x,y,pressure}], color, size, simulatePressure }), filling in
// all the bookkeeping fields Excalidraw expects on every element.

function randomId() {
  return crypto.randomUUID();
}

function seed() {
  return Math.floor(Math.random() * 2 ** 31);
}

export function strokeToFreedrawElement(stroke) {
  const points = stroke.points || [];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const relPoints = points.map((p) => [p.x - minX, p.y - minY]);
  const pressures = points.map((p) => (typeof p.pressure === 'number' ? p.pressure : 0.5));

  return {
    id: randomId(),
    type: 'freedraw',
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    angle: 0,
    strokeColor: stroke.color || '#1f2937',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: stroke.size || 3,
    strokeStyle: 'solid',
    roundness: null,
    roughness: 1,
    opacity: 100,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    points: relPoints,
    pressures,
    simulatePressure: !!stroke.simulatePressure,
    lastCommittedPoint: null,
  };
}
