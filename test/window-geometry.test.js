import test from 'node:test';
import assert from 'node:assert/strict';
import { panelBounds } from '../desktop/window-geometry.js';

test('opens at 1036 x 961, the size Gio uses, centered in his work area', () => {
  assert.deepEqual(panelBounds({ x: 0, y: 33, width: 1800, height: 1136 }), { x: 382, y: 121, width: 1036, height: 961 });
});

test('a smaller screen keeps the default panel inside it', () => {
  assert.deepEqual(panelBounds({ x: 0, y: 25, width: 1000, height: 700 }), { x: 0, y: 25, width: 1000, height: 700 });
  assert.equal(panelBounds({ x: 0, y: 0, width: 3000, height: 1800 }).width, 1036);
});

test('reopens at the width the user chose, kept inside the screen', () => {
  assert.deepEqual(panelBounds({ x: 0, y: 25, width: 1440, height: 875 }, 1000), { x: 220, y: 25, width: 1000, height: 875 });
  assert.deepEqual(panelBounds({ x: 0, y: 25, width: 1440, height: 875 }, 1000, 600), { x: 220, y: 163, width: 1000, height: 600 }, 'a height he dragged to');
  assert.equal(panelBounds({ x: 0, y: 25, width: 1440, height: 875 }, 1000, 5000).height, 875);
  assert.equal(panelBounds({ x: 0, y: 25, width: 1440, height: 875 }, 1000, 100).height, 300);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1440, height: 875 }, 2600).width, 1440);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1440, height: 875 }, 200).width, 340);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1440, height: 875 }, null).width, 1036);
});

test('centers the assistant inside a display left of the primary display', () => {
  assert.deepEqual(panelBounds({ x: -1440, y: 25, width: 1440, height: 875 }, 900, 650), { x: -1170, y: 138, width: 900, height: 650 });
});

test('invalid saved dimensions use the default and positive tiny dimensions stay usable', () => {
  assert.equal(panelBounds({ x: 0, y: 0, width: 1800, height: 1100 }, NaN, -1).width, 1036);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1800, height: 1100 }, 64, 50).width, 340);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1800, height: 1100 }, 64, 50).height, 300);
});
