import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { drawPng } from '../src/png.js';

export const TOKEN = 's3cret';
export const png = (w = 8, h = 8, c = [200, 50, 50, 255], opts) => drawPng(w, h, () => c, opts);
export const sprite = (id, extra = {}) => ({ id, description: `Image ${id}`, spec: { width: 8, height: 8 }, target: `${id}.png`, ...extra });

/** Starts a server on a random port with an in-memory database. */
export async function boot(opts = {}) {
  const db = openDb(':memory:');
  const server = createServer({ db, token: TOKEN, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref(); // a failing test must not keep the runner alive
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const post = (body) => api('/api/requests', { method: 'POST', body: JSON.stringify(body) });
  const upload = (id, body) => api(`/api/upload?id=${encodeURIComponent(id)}`, { method: 'POST', body });
  const state = async () => (await api('/api/state')).json();
  return { db, base, api, post, upload, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) };
}
