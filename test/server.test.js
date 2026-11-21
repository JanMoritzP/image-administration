import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { drawPng } from '../src/png.js';
import { tmpProject } from './helpers.js';

const CONTRACT = `
contract: "1.0"
project: { name: Test, root: game }
sprites:
  - id: hero/idle
    description: The hero standing still.
    spec: { width: 8, height: 8, alpha: required }
    targets: [a/hero.png, b/hero_copy.png]
  - id: ui/bg
    description: Background.
    spec: { minWidth: 4, strict: false }
    target: ui/bg.png
`;

async function boot(extra = {}) {
  const dir = tmpProject({ 'sprites.contract.yml': CONTRACT, ...extra });
  const server = createServer(dir);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, { ...init, headers: { 'X-Sprite-Admin': '1', ...(init.headers ?? {}) } });
  return { dir, base, api, close: () => new Promise((r) => server.close(r)), game: path.join(dir, 'game') };
}
const png = (w, h, opts) => drawPng(w, h, () => [200, 50, 50, 255], opts);

test('state starts all-missing; upload with wrong size is rejected and writes nothing', async () => {
  const t = await boot();
  const st = await (await t.api('/api/state')).json();
  assert.equal(st.summary.total, 2); assert.equal(st.summary.missing, 2); assert.equal(st.summary.percent, 0);
  const bad = await t.api('/api/upload?id=hero/idle', { method: 'POST', body: png(9, 8) });
  assert.equal(bad.status, 422);
  const j = await bad.json();
  assert.match(j.errors.join(' '), /width is 9px/);
  assert.equal(fs.existsSync(t.game), false);
  await t.close();
});

test('valid upload is delivered to every target, state flips to available', async () => {
  const t = await boot();
  const ok = await t.api('/api/upload?id=hero/idle', { method: 'POST', body: png(8, 8) });
  assert.equal(ok.status, 200);
  assert.ok(fs.existsSync(path.join(t.game, 'a/hero.png')));
  assert.ok(fs.existsSync(path.join(t.game, 'b/hero_copy.png')));
  const st = await (await t.api('/api/state')).json();
  assert.equal(st.sprites[0].status, 'available');
  assert.equal(st.summary.done, 1); assert.equal(st.summary.percent, 50);
  const img = await t.api('/api/image?id=hero/idle');
  assert.equal(img.headers.get('content-type'), 'image/png');
  await t.close();
});

test('replacing an image backs up the previous one', async () => {
  const t = await boot();
  await t.api('/api/upload?id=hero/idle', { method: 'POST', body: png(8, 8) });
  await t.api('/api/upload?id=hero/idle', { method: 'POST', body: drawPng(8, 8, () => [0, 0, 255, 255]) });
  const backups = path.join(t.game, '.sprite-admin/backups');
  const stamps = fs.readdirSync(backups);
  assert.equal(stamps.length, 1);
  assert.ok(fs.existsSync(path.join(backups, stamps[0], 'a/hero.png')));
  await t.close();
});

test('format/extension, alpha and non-image uploads are refused; lenient spec only warns', async () => {
  const t = await boot();
  const noAlpha = await t.api('/api/upload?id=hero/idle', { method: 'POST', body: png(8, 8, { alpha: false }) });
  assert.equal(noAlpha.status, 422);
  const junk = await t.api('/api/upload?id=hero/idle', { method: 'POST', body: Buffer.from('not an image') });
  assert.equal(junk.status, 422);
  const svg = await t.api('/api/upload?id=hero/idle', { method: 'POST', body: Buffer.from('<svg width="8" height="8"></svg>') });
  assert.match((await svg.json()).errors.join(' '), /needs a PNG file/);
  const lenient = await t.api('/api/upload?id=ui/bg', { method: 'POST', body: png(2, 2) });
  assert.equal(lenient.status, 200);
  assert.equal((await lenient.json()).warnings.length, 1); // strict:false turns the minWidth violation into a warning
  await t.close();
});

test('unknown id, missing CSRF header and foreign Host header are blocked', async () => {
  const t = await boot();
  assert.equal((await t.api('/api/upload?id=nope', { method: 'POST', body: png(8, 8) })).status, 404);
  assert.equal((await fetch(`${t.base}/api/upload?id=hero/idle`, { method: 'POST', body: png(8, 8) })).status, 403);
  const r = await new Promise((resolve) => {
    import('node:http').then(({ default: http }) => http.get(`${t.base}/api/state`, { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode)));
  });
  assert.equal(r, 403);
  assert.equal((await fetch(`${t.base}/..%2f..%2fpackage.json`)).status, 404);
  await t.close();
});

test('partially delivered sprites are detected and can be synced', async () => {
  const t = await boot({ 'game/a/hero.png': png(8, 8) });
  let st = await (await t.api('/api/state')).json();
  assert.equal(st.sprites[0].status, 'partial');
  const r = await t.api('/api/sync?id=hero/idle', { method: 'POST' });
  assert.equal(r.status, 200);
  st = await (await t.api('/api/state')).json();
  assert.equal(st.sprites[0].status, 'available');
  await t.close();
});

test('existing file that violates the spec is reported invalid', async () => {
  const t = await boot({ 'game/a/hero.png': png(5, 5), 'game/b/hero_copy.png': png(5, 5) });
  const st = await (await t.api('/api/state')).json();
  assert.equal(st.sprites[0].status, 'invalid');
  assert.equal(st.summary.invalid, 1);
  await t.close();
});
