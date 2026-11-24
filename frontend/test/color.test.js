// Run: npm test (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHex, hsvToHex, hexToHsv } from '../src/lib/color.js';

test('normalizeHex accepts #rgb, rgb and #rrggbb in any case', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('f80'), '#ff8800');
  assert.equal(normalizeHex(' #1F2937 '), '#1f2937');
  for (const bad of ['', '#12', '#12345', '#gggggg', null, undefined, '#1234567']) assert.equal(normalizeHex(bad), null, String(bad));
});

test('hsvToHex gives the primaries, white, black and grey', () => {
  assert.equal(hsvToHex(0, 1, 1), '#ff0000');
  assert.equal(hsvToHex(60, 1, 1), '#ffff00');
  assert.equal(hsvToHex(120, 1, 1), '#00ff00');
  assert.equal(hsvToHex(180, 1, 1), '#00ffff');
  assert.equal(hsvToHex(240, 1, 1), '#0000ff');
  assert.equal(hsvToHex(300, 1, 1), '#ff00ff');
  assert.equal(hsvToHex(360, 1, 1), '#ff0000');
  assert.equal(hsvToHex(123, 0, 1), '#ffffff');
  assert.equal(hsvToHex(123, 1, 0), '#000000');
  assert.equal(hsvToHex(0, 0, 0.5), '#808080');
});

test('hex -> hsv -> hex round-trips every colour it is given', () => {
  for (const hex of ['#1f2937', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#7048e8', '#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffffff', '#000000', '#808080', '#010203', '#fefdfc']) {
    const { h, s, v } = hexToHsv(hex);
    assert.equal(hsvToHex(h, s, v), hex, hex);
  }
  // A coarse sweep of the whole cube.
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    const { h, s, v } = hexToHsv(hex);
    assert.equal(hsvToHex(h, s, v), hex, hex);
  }
});

test('hexToHsv reads hue, saturation and value', () => {
  assert.deepEqual(hexToHsv('#ff0000'), { h: 0, s: 1, v: 1 });
  const blue = hexToHsv('#0000ff');
  assert.equal(blue.h, 240);
  const grey = hexToHsv('#808080');
  assert.equal(grey.s, 0);
  assert.ok(Math.abs(grey.v - 128 / 255) < 1e-9);
  assert.deepEqual(hexToHsv('nope'), { h: 0, s: 0, v: 0 });
});
