import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, png, sprite, TOKEN } from './helpers.js';
import { sha256 } from '../src/store.js';

test('every API call needs the token; the UI shell does not; /healthz is open', async () => {
  const t = await boot();
  assert.equal((await fetch(`${t.base}/api/state`)).status, 401);
  assert.equal((await fetch(`${t.base}/api/state`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await t.api('/api/state')).status, 200);
  assert.equal((await fetch(`${t.base}/`)).status, 200);
  assert.equal((await fetch(`${t.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${t.base}/..%2f..%2fpackage.json`)).status, 404);
  await t.close();
});

test('browser login: cookie works for reads, writes also need the X-Sprite-Admin header, wrong token is refused', async () => {
  const t = await boot();
  const bad = await fetch(`${t.base}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'wrong' }) });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${t.base}/api/login`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.ok(!setCookie.includes(TOKEN)); // the cookie never contains the token itself
  const cookie = setCookie.split(';')[0];
  assert.equal((await fetch(`${t.base}/api/state`, { headers: { cookie } })).status, 200);
  await t.post({ sprites: [sprite('a/b')] });
  const noHeader = await fetch(`${t.base}/api/upload?id=a/b`, { method: 'POST', headers: { cookie }, body: png() });
  assert.equal(noHeader.status, 403);
  const withHeader = await fetch(`${t.base}/api/upload?id=a/b`, { method: 'POST', headers: { cookie, 'X-Sprite-Admin': '1' }, body: png() });
  assert.equal(withHeader.status, 200);
  await t.close();
});

test('foreign Host header is blocked when bound to loopback', async () => {
  const t = await boot();
  const status = await new Promise((resolve) => http.get(`${t.base}/healthz`, { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode)));
  assert.equal(status, 403);
  await t.close();
});

test('request flow: project, folders, sprites, replace by id, state and folder tree', async () => {
  const t = await boot();
  const r = await t.post({ project: { name: 'Shop', description: 'Web shop images' }, folders: { shop: { title: 'Shop pages', icon: '🛒' } }, sprites: [sprite('shop/a'), sprite('shop/deep/b'), sprite('misc')] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).sprites, ['shop/a', 'shop/deep/b', 'misc']);
  let st = await t.state();
  assert.equal(st.project.name, 'Shop');
  assert.equal(st.summary.total, 3); assert.equal(st.summary.missing, 3);
  assert.deepEqual(st.folders.map((f) => [f.id, f.depth, f.total]), [['shop', 1, 2], ['shop/deep', 2, 1]]);
  assert.equal(st.folders[0].title, 'Shop pages');
  assert.deepEqual(st.sprites[0].targets, [{ path: 'shop/a.png', url: '/files/shop/a.png' }]);
  assert.deepEqual(st.sprites[0].spec, { width: 8, height: 8, formats: ['png'], alpha: 'any', strict: true });

  assert.equal((await t.post({ sprites: [sprite('shop/a', { description: 'Changed' })] })).status, 200);
  st = await t.state();
  assert.equal(st.summary.total, 3);
  assert.equal(st.sprites.find((s) => s.id === 'shop/a').description, 'Changed');
  assert.deepEqual(st.sprites.map((s) => s.id), ['shop/a', 'shop/deep/b', 'misc']); // order is stable
  await t.close();
});

test('invalid requests are rejected as a whole and change nothing', async () => {
  const t = await boot();
  assert.equal((await t.post({ sprites: [sprite('keep/me')] })).status, 200);
  const bad = async (body, re, status = 422) => { const r = await t.post(body); assert.equal(r.status, status); assert.match((await r.json()).errors.join(' | '), re); };
  await bad({ sprites: [sprite('ok/one'), { id: 'bad/one', target: 'bad/one.png' }] }, /description/);
  await bad({ sprites: [{ id: 'x/y', description: 'd', target: '../escape.png' }] }, /relative path/);
  await bad({ sprites: [{ id: 'x/y', description: 'd', target: 'x/y.txt' }] }, /must end in one of/);
  await bad({ sprites: [{ id: 'x/y', description: 'd', target: 'x/y.png', spec: { width: -3 } }] }, /positive integer/);
  await bad({ sprites: [{ id: 'x/y', description: 'd', target: 'x/y.png', spec: { formats: ['jpg'] } }] }, /spec.formats only allows jpg/);
  await bad({ sprites: [sprite('a/b'), sprite('a/b')] }, /appears twice/);
  await bad({ sprites: [{ id: 'bad id', description: 'd', target: 'a.png' }] }, /"id" is required/);
  await bad({ sprites: [sprite('other/one', { target: 'keep/me.png' })] }, /already used by sprite "keep\/me"/); // path owned by another sprite
  await bad({ sprites: [sprite('p/one', { target: 'same.png' }), sprite('p/two', { target: 'same.png' })] }, /already used/);
  await bad({}, /nothing to add/);
  await bad([], /must be a JSON object/);
  assert.equal((await t.api('/api/requests', { method: 'POST', body: '{nope' })).status, 400);
  assert.deepEqual((await t.state()).sprites.map((s) => s.id), ['keep/me']); // nothing from the failed batches (incl. the valid "ok/one") survived
  await t.close();
});

test('sprites may swap paths within one request; several targets share one image', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('a', { target: 'one.png' }), sprite('b', { target: 'two.png' })] });
  assert.equal((await t.post({ sprites: [sprite('a', { target: 'two.png' }), sprite('b', { target: 'one.png' })] })).status, 200);
  const { target, ...multi } = sprite('multi', { targets: ['m/x.png', { path: 'm/y.png', label: 'second' }] });
  assert.equal((await t.post({ sprites: [multi] })).status, 200);
  const bytes = png();
  assert.equal((await t.upload('multi', bytes)).status, 200);
  for (const p of ['m/x.png', 'm/y.png']) {
    const r = await t.api(`/files/${p}`);
    assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  }
  assert.equal((await t.state()).sprites.find((s) => s.id === 'multi').targets[1].label, 'second');
  await t.close();
});

test('upload validates against the spec and stores nothing on failure', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('hero', { spec: { width: 8, height: 8, alpha: 'required' } }), sprite('bg', { spec: { minWidth: 4, strict: false } })] });
  const refused = async (body, re) => { const r = await t.upload('hero', body); assert.equal(r.status, 422); assert.match((await r.json()).errors.join(' '), re); };
  await refused(png(9, 8), /width is 9px/);
  await refused(png(8, 8, [1, 2, 3, 255], { alpha: false }), /transparency/);
  await refused(Buffer.from('not an image'), /not a PNG/);
  await refused(Buffer.from('<svg width="8" height="8"></svg>'), /needs a PNG file/);
  assert.equal((await t.state()).summary.done, 0);
  assert.equal((await t.upload('hero', Buffer.alloc(0))).status, 400);
  assert.equal((await t.upload('nope', png())).status, 404);
  const lenient = await t.upload('bg', png(2, 2));
  assert.equal(lenient.status, 200);
  assert.equal((await lenient.json()).warnings.length, 1); // strict:false turns the minWidth violation into a warning
  await t.close();
});

test('valid upload is stored in the database and served by id and by path with ETag', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('shop/banner', { target: 'site/banner.png' })] });
  const bytes = png();
  const up = await t.upload('shop/banner', bytes);
  assert.equal(up.status, 200);
  const j = await up.json();
  assert.equal(j.sprite.status, 'available');
  assert.deepEqual([j.sprite.image.format, j.sprite.image.width, j.sprite.image.height], ['png', 8, 8]);
  const st = await t.state();
  assert.equal(st.summary.done, 1); assert.equal(st.summary.percent, 100);

  for (const p of ['/api/file?id=shop/banner', '/files/site/banner.png']) {
    const r = await t.api(p);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('etag'), `"${sha256(bytes)}"`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  }
  const cached = await t.api('/files/site/banner.png', { headers: { 'If-None-Match': `"${sha256(bytes)}"` } });
  assert.equal(cached.status, 304);
  assert.equal((await t.api('/files/nope.png')).status, 404);
  await t.close();
});

test('/files needs the token unless publicFiles is on', async () => {
  const closed = await boot();
  await closed.post({ sprites: [sprite('a')] }); await closed.upload('a', png());
  assert.equal((await fetch(`${closed.base}/files/a.png`)).status, 401);
  await closed.close();
  const open = await boot({ publicFiles: true });
  await open.post({ sprites: [sprite('a')] }); await open.upload('a', png());
  assert.equal((await fetch(`${open.base}/files/a.png`)).status, 200);
  assert.equal((await fetch(`${open.base}/api/state`)).status, 401); // the API stays closed
  await open.close();
});

test('replacing an image keeps the previous versions (last 5)', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('a')] });
  const first = png(8, 8, [1, 1, 1, 255]);
  for (let i = 0; i < 8; i++) await t.upload('a', i === 0 ? first : png(8, 8, [i * 10, 0, 0, 255]));
  const { versions } = await (await t.api('/api/history?id=a')).json();
  assert.equal(versions.length, 5);
  const old = await t.api(`/api/file?id=a&history=${versions.at(-1).version}`);
  assert.equal(old.status, 200);
  assert.notDeepEqual(Buffer.from(await old.arrayBuffer()), first); // the very first one has been pruned
  await t.close();
});

test('changing the spec afterwards marks an existing image invalid; deleting a sprite removes image and paths', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('a')] }); await t.upload('a', png());
  await t.post({ sprites: [sprite('a', { spec: { width: 16, height: 16 } })] });
  let st = await t.state();
  assert.equal(st.sprites[0].status, 'invalid');
  assert.match(st.sprites[0].issues[0].message, /width is 8px, must be exactly 16px/);
  assert.equal(st.summary.invalid, 1);
  assert.equal((await t.api('/api/file?id=a')).status, 200); // the image itself is kept

  assert.equal((await t.api('/api/sprites?id=a', { method: 'DELETE' })).status, 200);
  assert.equal((await t.api('/api/sprites?id=a', { method: 'DELETE' })).status, 404);
  assert.equal((await t.state()).summary.total, 0);
  assert.equal((await t.api('/files/a.png')).status, 404);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM images').get().n, 0);
  // the freed path can be used again
  assert.equal((await t.post({ sprites: [sprite('other', { target: 'a.png' })] })).status, 200);
  await t.close();
});

test('uploads and deletions are logged as events that can be polled with since', async () => {
  const t = await boot();
  await t.post({ sprites: [sprite('shop/a'), sprite('b')] });
  const bytes = png();
  await t.upload('shop/a', bytes); await t.upload('b', png(8, 8, [9, 9, 9, 255]));
  await t.upload('shop/a', png(9, 9)); // refused: no event
  await t.api('/api/sprites?id=b', { method: 'DELETE' });
  const { events } = await (await t.api('/api/events')).json();
  assert.deepEqual(events.map((e) => [e.seq, e.id, e.type]), [[1, 'shop/a', 'image.delivered'], [2, 'b', 'image.delivered'], [3, 'b', 'sprite.deleted']]);
  assert.deepEqual([events[0].format, events[0].width, events[0].height, events[0].bytes, events[0].sha256], ['png', 8, 8, bytes.length, sha256(bytes)]);
  assert.deepEqual(events[0].targets, ['shop/a.png']);
  assert.deepEqual((await (await t.api('/api/events?since=2')).json()).events.map((e) => e.seq), [3]);
  assert.equal((await (await t.api('/api/events?limit=1')).json()).events.length, 1);
  await t.close();
});

test('jpg targets: stored and served as image/jpeg; a PNG upload is refused', async () => {
  const t = await boot();
  await t.post({ sprites: [{ id: 'photo', description: 'A photo', target: 'p/photo.jpg', spec: { formats: ['jpeg'] } }] });
  assert.equal((await t.state()).sprites[0].spec.formats[0], 'jpg');
  const r = await t.upload('photo', png());
  assert.equal(r.status, 422);
  assert.match((await r.json()).errors.join(' '), /needs a JPG file/);
  await t.close();
});
