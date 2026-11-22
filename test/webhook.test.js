import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, png, sprite } from './helpers.js';
import { sha256 } from '../src/store.js';

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
const delivery = async (t, id, status) => until(async () => { const st = await t.state(); return st.delivery?.[id]?.status === status && st.delivery[id]; });

test('webhook receives the image bytes with metadata and the state reports delivery', async () => {
  const rx = await receiver();
  const t = await boot({ webhook: { url: rx.url, token: 'hook-token' } });
  await t.post({ sprites: [sprite('shop/a')] });
  const bytes = png();
  await t.upload('shop/a', bytes);

  await until(() => rx.calls.length === 1);
  const [call] = rx.calls;
  assert.deepEqual(call.body, bytes);
  assert.equal(call.headers['content-type'], 'image/png');
  assert.equal(call.headers.authorization, 'Bearer hook-token');
  assert.equal(call.headers['x-sprite-id'], 'shop/a');
  assert.equal(call.headers['x-sprite-seq'], '1');
  assert.equal(call.headers['x-sprite-sha256'], sha256(bytes));
  assert.equal(call.headers['x-sprite-format'], 'png');
  assert.equal(call.headers['x-sprite-width'], '8');
  assert.equal(call.headers['x-sprite-height'], '8');
  assert.equal((await delivery(t, 'shop/a', 'delivered')).attempts, 1);
  await t.close(); await rx.close();
});

test('webhook retries on server errors, gives up on client errors, and reports failure', async () => {
  const flaky = await receiver((n) => (n < 3 ? 500 : 200));
  let t = await boot({ webhook: { url: flaky.url, baseDelayMs: 10 } });
  await t.post({ sprites: [sprite('shop/a')] }); await t.upload('shop/a', png());
  assert.equal((await delivery(t, 'shop/a', 'delivered')).attempts, 3);
  assert.equal(flaky.calls.length, 3);
  await t.close(); await flaky.close();

  const rejecting = await receiver(() => 400);
  t = await boot({ webhook: { url: rejecting.url, baseDelayMs: 10 } });
  await t.post({ sprites: [sprite('shop/a')] }); await t.upload('shop/a', png());
  const f = await delivery(t, 'shop/a', 'failed');
  assert.deepEqual([f.attempts, f.error], [1, 'HTTP 400']);
  await t.close(); await rejecting.close();

  // unreachable plugin: the upload itself still succeeds, delivery ends up failed after all retries
  t = await boot({ webhook: { url: 'http://127.0.0.1:1/hook', retries: 2, baseDelayMs: 10 } });
  await t.post({ sprites: [sprite('shop/a')] });
  assert.equal((await t.upload('shop/a', png())).status, 200);
  assert.equal((await delivery(t, 'shop/a', 'failed')).attempts, 2);
  await t.close();
});

test('without a webhook there is no delivery state', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('a')] }); await t.upload('a', png());
  assert.equal((await t.state()).delivery, undefined);
  await t.close();
});
