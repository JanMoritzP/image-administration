import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, png, sprite } from './helpers.js';
import { openDb } from '../src/db.js';
import { createProjects } from '../src/projects.js';

const json = (r) => r.json();

test('a request that names a project creates it; projects are separate', async () => {
  const t = await boot();
  const a = await t.post({ project: { id: 'harbour', name: 'Harbour', description: 'First adventure' }, sprites: [sprite('pages/aria/portrait')] });
  assert.equal(a.status, 200);
  assert.equal((await json(a)).project, 'harbour');
  await t.post({ project: { id: 'crypt', name: 'Crypt' }, sprites: [sprite('pages/aria/portrait')] }); // same id and same path, other project
  await t.post({ sprites: [sprite('only/default')] });

  const list = (await json(await t.api('/api/projects'))).projects;
  assert.deepEqual(list.map((p) => p.id), ['default', 'crypt', 'harbour']);
  assert.equal(list.find((p) => p.id === 'harbour').name, 'Harbour');
  assert.equal(list.find((p) => p.id === 'harbour').description, 'First adventure');
  assert.equal(list.find((p) => p.id === 'harbour').total, 1);

  const harbour = await json(await t.api('/api/state?project=harbour'));
  assert.equal(harbour.project.id, 'harbour');
  assert.equal(harbour.summary.total, 1);
  assert.deepEqual((await t.state()).sprites.map((s) => s.id), ['only/default']);
  await t.close();
});

test('uploads, files, history and events belong to one project', async () => {
  const t = await boot();
  await t.post({ project: { id: 'one' }, sprites: [sprite('a')] });
  await t.post({ project: { id: 'two' }, sprites: [sprite('a')] });
  const red = png(8, 8, [255, 0, 0, 255]), blue = png(8, 8, [0, 0, 255, 255]);
  assert.equal((await t.api('/api/upload?id=a&project=one', { method: 'POST', body: red })).status, 200);
  assert.equal((await t.api('/api/upload?id=a&project=two', { method: 'POST', body: blue })).status, 200);

  assert.deepEqual(Buffer.from(await (await t.api('/api/file?id=a&project=one')).arrayBuffer()), red);
  assert.deepEqual(Buffer.from(await (await t.api('/api/file?id=a&project=two')).arrayBuffer()), blue);
  assert.equal((await t.api('/api/file?id=a')).status, 404); // the default project has no such sprite

  const ev = (await json(await t.api('/api/events?since=0&project=one'))).events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].project, 'one');
  assert.equal(ev[0].seq, 1); // each project counts its own events
  assert.equal((await json(await t.api('/api/events?since=0&project=two'))).events[0].seq, 1);

  // by path: /files/<project>/<path>, while the default project keeps /files/<path>
  const byPath = await t.api('/files/one/a.png');
  assert.equal(byPath.status, 200);
  assert.deepEqual(Buffer.from(await byPath.arrayBuffer()), red);
  await t.post({ sprites: [sprite('d')] });
  await t.upload('d', red);
  assert.equal((await t.api('/files/d.png')).status, 200);
  await t.close();
});

test('unknown projects are refused, a bad id is a 422, a refused request leaves no project behind', async () => {
  const t = await boot();
  assert.equal((await t.api('/api/state?project=nope')).status, 404);
  assert.equal((await t.api('/api/upload?id=a&project=nope', { method: 'POST', body: png() })).status, 404);
  const bad = await t.post({ project: { id: 'Not Valid' }, sprites: [sprite('a')] });
  assert.equal(bad.status, 422);
  assert.match((await json(bad)).errors.join(' '), /project\/id/);
  // a sprite without description is invalid: the new project must not stay
  assert.equal((await t.post({ project: { id: 'ghost' }, sprites: [{ id: 'x', target: 'x.png' }] })).status, 422);
  assert.deepEqual((await json(await t.api('/api/projects'))).projects.map((p) => p.id), ['default']);
  // a target path clash inside the request rolls back too
  await t.post({ project: { id: 'real' }, sprites: [sprite('a')] });
  const clash = await t.post({ project: { id: 'real' }, sprites: [sprite('b', { target: 'a.png' })] });
  assert.equal(clash.status, 422);
  assert.ok((await json(await t.api('/api/projects'))).projects.some((p) => p.id === 'real')); // an existing project stays
  await t.close();
});

test('the default project is the one without a name, and a project can be deleted', async () => {
  const t = await boot();
  await t.post({ project: { id: 'old', name: 'Old' }, sprites: [sprite('a')] });
  assert.equal((await t.api('/api/projects?id=old', { method: 'DELETE' })).status, 200);
  assert.equal((await t.api('/api/state?project=old')).status, 404);
  assert.equal((await t.api('/api/projects?id=old', { method: 'DELETE' })).status, 404);
  await t.close();
});

test('the default project is wiped empty, so a plugin has to recreate it', async () => {
  const t = await boot();
  await t.post({ project: { name: 'Mine', description: 'D' }, folders: { f: { title: 'F' } }, sprites: [sprite('a'), sprite('f/b')] });
  await t.upload('a', png());
  await t.upload('a', png(8, 8, [1, 2, 3, 255])); // history
  await t.post({ project: { id: 'other' }, sprites: [sprite('x')] });
  const before = (await json(await t.api('/api/events?since=0'))).events.at(-1).seq;

  const r = await t.api('/api/projects?id=default', { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await json(r)).wiped, true);
  const s = await t.state();
  assert.equal(s.sprites.length, 0);
  assert.equal(s.folders.length, 0);
  assert.equal(s.project.name, 'Image Administration');
  assert.equal(s.project.description, '');
  assert.equal((await t.api('/files/a.png')).status, 404);
  assert.deepEqual((await json(await t.api('/api/events?since=0'))).events, []);
  for (const table of ['sprites', 'folders', 'targets', 'images', 'image_history', 'events', 'meta']) assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  assert.equal((await json(await t.api('/api/state?project=other'))).sprites.length, 1); // other projects are untouched

  // recreating works, and event numbers keep counting
  await t.post({ sprites: [sprite('a')] });
  await t.upload('a', png());
  assert.ok((await json(await t.api('/api/events?since=0'))).events[0].seq > before);
  await t.close();
});

test('the webhook says which project an image belongs to', async () => {
  const calls = [];
  const rx = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { calls.push(req.headers); res.writeHead(200); res.end(); }); });
  await new Promise((r) => rx.listen(0, '127.0.0.1', r));
  const t = await boot({ webhook: { url: `http://127.0.0.1:${rx.address().port}/hook` } });
  await t.post({ project: { id: 'harbour' }, sprites: [sprite('a')] });
  await t.post({ sprites: [sprite('b')] });
  await t.api('/api/upload?id=a&project=harbour', { method: 'POST', body: png() });
  await t.upload('b', png());
  for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((h) => [h['x-sprite-project'], h['x-sprite-id']]).sort(), [['default', 'b'], ['harbour', 'a']]);
  assert.equal((await json(await t.api('/api/state?project=harbour'))).delivery.a.status, 'delivered');
  rx.closeAllConnections?.(); rx.close();
  await t.close();
});

test('projects live in their own files and come back after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  const make = () => createProjects({ db: openDb(':memory:'), dir });
  const first = make();
  first.ensure('harbour');
  assert.ok(fs.existsSync(path.join(dir, 'harbour.db')));
  first.close();
  const second = make();
  assert.deepEqual(second.ids(), ['default', 'harbour']);
  assert.ok(second.get('harbour'));
  assert.equal(second.remove('harbour'), true);
  assert.ok(!fs.existsSync(path.join(dir, 'harbour.db')));
  assert.equal(second.remove('default'), false);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
