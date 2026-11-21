import test from 'node:test';
import assert from 'node:assert/strict';
import { drawPng } from '../src/png.js';
import { probeImage, checkSpec } from '../src/images.js';

test('PNG: dimensions and alpha detection', () => {
  const a = probeImage(drawPng(12, 7, () => [1, 2, 3, 128]));
  assert.deepEqual([a.format, a.width, a.height, a.alpha], ['png', 12, 7, true]);
  const b = probeImage(drawPng(4, 4, () => [1, 2, 3], { alpha: false }));
  assert.equal(b.alpha, false);
});

test('non-images are rejected, svg is parsed, unsafe svg flagged', () => {
  assert.equal(probeImage(Buffer.from('hello world')), null);
  const svg = probeImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="64px" height="32"></svg>'));
  assert.deepEqual([svg.format, svg.width, svg.height], ['svg', 64, 32]);
  assert.equal(probeImage(Buffer.from('<svg viewBox="0 0 10 20"><script>1</script></svg>')).unsafe, true);
  assert.equal(probeImage(Buffer.from('<svg viewBox="0 0 10 20"></svg>')).height, 20);
});

test('jpeg and gif headers', () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const j = probeImage(jpg);
  assert.deepEqual([j.format, j.width, j.height, j.alpha], ['jpg', 64, 32, false]);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([5, 0, 6, 0]), Buffer.alloc(10)]);
  assert.deepEqual([probeImage(gif).width, probeImage(gif).height], [5, 6]);
});

test('checkSpec covers every constraint', () => {
  const info = { format: 'png', width: 30, height: 20, alpha: false, bytes: 5000 };
  const msg = (spec) => checkSpec(info, spec).map((i) => i.code);
  assert.deepEqual(msg({ width: 32 }), ['width']);
  assert.deepEqual(msg({ minWidth: 40, maxHeight: 10 }), ['minWidth', 'maxHeight']);
  assert.deepEqual(msg({ aspect: '1:1' }), ['aspect']);
  assert.deepEqual(msg({ aspect: '3:2' }), []);
  assert.deepEqual(msg({ multipleOf: 8 }), ['multipleOf']);
  assert.deepEqual(msg({ alpha: 'required' }), ['alpha']);
  assert.deepEqual(msg({ maxBytes: 100 }), ['maxBytes']);
  assert.deepEqual(msg({ formats: ['webp'] }), ['format']);
  assert.equal(checkSpec(info, { width: 32, strict: false })[0].level, 'warn');
});
