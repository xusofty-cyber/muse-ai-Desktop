// Pilot P1 tests: pure window-bounds helpers (node:test, no deps).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeWindowBounds, ensureBoundsVisible } = require('../lib/window-bounds');

const DISPLAYS = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

test('sanitize: non-object input yields empty bounds', () => {
  assert.deepEqual(sanitizeWindowBounds(null), {});
  assert.deepEqual(sanitizeWindowBounds('x'), {});
});

test('sanitize: clamps to min and max sizes and rounds', () => {
  const b = sanitizeWindowBounds({ width: 10, height: 20.6, x: 1.4, y: 2.5 });
  assert.equal(b.width, 800);
  assert.equal(b.height, 560);
  assert.equal(b.x, 1);
  assert.equal(b.y, 3);
  const c = sanitizeWindowBounds({ width: 99999, height: 99999 });
  assert.equal(c.width, 7680);
  assert.equal(c.height, 4320);
});

test('sanitize: drops coordinates beyond the sanity range', () => {
  const b = sanitizeWindowBounds({ width: 1000, height: 800, x: 99999, y: -99999 });
  assert.equal(b.x, undefined);
  assert.equal(b.y, undefined);
  assert.equal(b.width, 1000);
});

test('ensureBoundsVisible: on-screen window is kept, sizes filled', () => {
  const b = ensureBoundsVisible({ x: 100, y: 100 }, DISPLAYS);
  assert.equal(b.x, 100);
  assert.equal(b.y, 100);
  assert.equal(b.width, 1200);
  assert.equal(b.height, 800);
});

test('ensureBoundsVisible: off-screen window is centred on the primary work area', () => {
  const b = ensureBoundsVisible({ x: 5000, y: 5000, width: 1000, height: 800 }, DISPLAYS);
  assert.equal(b.x, 460);
  assert.equal(b.y, 140);
  assert.equal(b.width, 1000);
  assert.equal(b.height, 800);
});

test('ensureBoundsVisible: barely-visible window (title rule) is centred', () => {
  // Only a sliver overlaps and the title bar is outside the work area.
  const b = ensureBoundsVisible({ x: 1900, y: 100, width: 1000, height: 800 }, DISPLAYS);
  assert.equal(b.x, 460);
  assert.equal(b.y, 140);
});

test('ensureBoundsVisible: no displays yields sanitised bounds unchanged', () => {
  const b = ensureBoundsVisible({ x: 100, y: 100, width: 1000, height: 800 }, []);
  assert.deepEqual(b, { x: 100, y: 100, width: 1000, height: 800 });
});
