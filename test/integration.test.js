import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { drawPng } from '../src/png.js';
import { sha256 } from '../src/integration.js';
import { tmpProject } from './helpers.js';

const TOKEN = 's3cret';
const CONTRACT = `
contract: "1.0"
project: { name: Test, root: game }
sprites:
  - id: manual/one
    description: A hand written sprite.
    spec: { width: 8, height: 8 }
    target: manual/one.png
`;
const png = (w = 8, h = 8, c = [200, 50, 50, 255]) => drawPng(w, h, () => c);
const sprite = (id, extra = {}) => ({ id, description: `Image ${id}`, spec: { width: 8, height: 8 }, target: `${id}.png`, ...extra });

async function boot(opts = {}) {
  const dir = tmpProject({ 'sprites.contract.yml': CONTRACT });
  const server = createServer(dir, { token: TOKEN, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const plugin = (p, init = {}) => fetch(base + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const ui = (p, init = {}) => fetch(base + p, { ...init, headers: { 'X-Sprite-Admin': '1', ...(init.headers ?? {}) } });
  const post = (body) => plugin('/api/requests', { method: 'POST', body: JSON.stringify(body) });
  return { dir, base, plugin, ui, post, close: () => new Promise((r) => server.close(r)), game: path.join(dir, 'game') };
}

/** A fake plugin that records webhook calls; `respond` decides the status code per call. */
async function receiver(respond = () => 200) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { calls.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(respond(calls.length)); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
}

test('plugin endpoints need the bearer token and are disabled without one', async () => {
  const t = await boot();
  assert.equal((await fetch(`${t.base}/api/events`)).status, 401);
  assert.equal((await fetch(`${t.base}/api/events`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await t.plugin('/api/events')).status, 200);
  await t.close();

  const dir = tmpProject({ 'sprites.contract.yml': CONTRACT });
  const open = createServer(dir);
  await new Promise((r) => open.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${open.address().port}/api/requests`, { method: 'POST', headers: { Authorization: 'Bearer x' }, body: '{}' });
  assert.equal(res.status, 503);
  await new Promise((r) => open.close(r));
});

test('plugin can request sprites, replace them by id, and they show up in the state', async () => {
  const t = await boot();
  const r = await t.post({ folders: { shop: { title: 'Shop' } }, sprites: [sprite('shop/a'), sprite('shop/b')] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).sprites, ['shop/a', 'shop/b']);
  let st = await (await t.ui('/api/state')).json();
  assert.equal(st.summary.total, 3);
  assert.ok(st.folders.some((f) => f.id === 'shop' && f.title === 'Shop'));

  // same id again replaces instead of duplicating
  assert.equal((await t.post({ sprites: [sprite('shop/a', { description: 'Changed' })] })).status, 200);
  st = await (await t.ui('/api/state')).json();
  assert.equal(st.summary.total, 3);
  assert.equal(st.sprites.find((s) => s.id === 'shop/a').description, 'Changed');
  assert.equal(fs.existsSync(path.join(t.dir, 'plugin.requests.json')), true);
  await t.close();
});

test('invalid requests are rejected and the contract stays untouched', async () => {
  const t = await boot();
  assert.equal((await t.post({ sprites: [sprite('ok/one')] })).status, 200);
  const file = path.join(t.dir, 'plugin.requests.json');
  const before = fs.readFileSync(file, 'utf8');

  const noDesc = await t.post({ sprites: [{ id: 'bad/one', target: 'bad/one.png' }] });
  assert.equal(noDesc.status, 422);
  assert.match((await noDesc.json()).errors.join(' '), /description/);

  const clash = await t.post({ sprites: [sprite('manual/one')] }); // already declared by the hand-written manifest
  assert.equal(clash.status, 422);
  assert.match((await clash.json()).errors.join(' '), /already used/);

  assert.equal((await t.post({ sprites: [{ description: 'no id' }] })).status, 400);
  assert.equal((await t.post({})).status, 400);
  assert.equal((await t.plugin('/api/requests', { method: 'POST', body: '{nope' })).status, 400);

  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const st = await (await t.ui('/api/state')).json();
  assert.deepEqual(st.sprites.map((s) => s.id), ['manual/one', 'ok/one']);
  assert.equal(st.diagnostics.length, 0);
  await t.close();
});

test('a rejected first request leaves no plugin file behind', async () => {
  const t = await boot();
  assert.equal((await t.post({ sprites: [{ id: 'x/y', description: 'd', target: '../escape.png' }] })).status, 422);
  assert.equal(fs.existsSync(path.join(t.dir, 'plugin.requests.json')), false);
  await t.close();
});

test('uploads are logged as events (pollable with since) and files can be fetched with a hash', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('shop/a')] });
  const bytes = png();
  assert.equal((await t.ui('/api/upload?id=shop/a', { method: 'POST', body: bytes })).status, 200);
  assert.equal((await t.ui('/api/upload?id=manual/one', { method: 'POST', body: png(8, 8, [1, 2, 3, 255]) })).status, 200);

  const { events } = await (await t.plugin('/api/events')).json();
  assert.deepEqual(events.map((e) => [e.seq, e.id, e.type]), [[1, 'shop/a', 'image.delivered'], [2, 'manual/one', 'image.delivered']]);
  assert.equal(events[0].sha256, sha256(bytes));
  assert.deepEqual(events[0].targets, ['shop/a.png']);
  assert.deepEqual((await (await t.plugin('/api/events?since=1')).json()).events.map((e) => e.seq), [2]);

  const f = await t.plugin('/api/file?id=shop/a');
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/png');
  assert.equal(f.headers.get('x-sprite-sha256'), sha256(bytes));
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), bytes);
  assert.equal((await t.plugin('/api/file?id=nope')).status, 404);

  // a failed upload produces no event
  assert.equal((await t.ui('/api/upload?id=shop/a', { method: 'POST', body: png(9, 9) })).status, 422);
  assert.equal((await (await t.plugin('/api/events')).json()).events.length, 2);
  await t.close();
});

test('webhook receives the image bytes with metadata and the state reports delivery', async () => {
  const rx = await receiver();
  const t = await boot({ webhook: { url: rx.url, token: 'hook-token' } });
  await t.post({ sprites: [sprite('shop/a')] });
  const bytes = png();
  await t.ui('/api/upload?id=shop/a', { method: 'POST', body: bytes });

  await until(() => rx.calls.length === 1);
  const [call] = rx.calls;
  assert.deepEqual(call.body, bytes);
  assert.equal(call.headers['content-type'], 'image/png');
  assert.equal(call.headers.authorization, 'Bearer hook-token');
  assert.equal(call.headers['x-sprite-id'], 'shop/a');
  assert.equal(call.headers['x-sprite-seq'], '1');
  assert.equal(call.headers['x-sprite-sha256'], sha256(bytes));

  const d = await until(async () => { const st = await (await t.ui('/api/state')).json(); return st.delivery?.['shop/a']?.status === 'delivered' && st.delivery['shop/a']; });
  assert.equal(d.attempts, 1);
  await t.close(); await rx.close();
});

test('webhook retries on server errors, gives up on client errors, and reports failure', async () => {
  const flaky = await receiver((n) => (n < 3 ? 500 : 200));
  let t = await boot({ webhook: { url: flaky.url, baseDelayMs: 10 } });
  await t.post({ sprites: [sprite('shop/a')] });
  await t.ui('/api/upload?id=shop/a', { method: 'POST', body: png() });
  const d = await until(async () => { const st = await (await t.ui('/api/state')).json(); return st.delivery?.['shop/a']?.status === 'delivered' && st.delivery['shop/a']; });
  assert.equal(d.attempts, 3);
  assert.equal(flaky.calls.length, 3);
  await t.close(); await flaky.close();

  const rejecting = await receiver(() => 400);
  t = await boot({ webhook: { url: rejecting.url, baseDelayMs: 10 } });
  await t.post({ sprites: [sprite('shop/a')] });
  await t.ui('/api/upload?id=shop/a', { method: 'POST', body: png() });
  const f = await until(async () => { const st = await (await t.ui('/api/state')).json(); return st.delivery?.['shop/a']?.status === 'failed' && st.delivery['shop/a']; });
  assert.equal(f.attempts, 1);
  assert.equal(f.error, 'HTTP 400');
  await t.close(); await rejecting.close();

  // unreachable plugin: the upload itself still succeeds, delivery ends up failed after all retries
  t = await boot({ webhook: { url: 'http://127.0.0.1:1/hook', retries: 2, baseDelayMs: 10 } });
  await t.post({ sprites: [sprite('shop/a')] });
  assert.equal((await t.ui('/api/upload?id=shop/a', { method: 'POST', body: png() })).status, 200);
  const u = await until(async () => { const st = await (await t.ui('/api/state')).json(); return st.delivery?.['shop/a']?.status === 'failed' && st.delivery['shop/a']; });
  assert.equal(u.attempts, 2);
  await t.close();
});
