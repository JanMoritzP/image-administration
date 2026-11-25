import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildState } from './status.js';
import { validateRequest } from './validate.js';
import { applyRequest, deleteSprite, saveImage, getImage, listEvents, listHistory, DEFAULT_MAX_UPLOAD_BYTES } from './store.js';
import { MIME } from './formats.js';
import { tokenOk, safeEqual, sessionCookieValue, createDelivery } from './integration.js';
import { createProjects, DEFAULT_PROJECT } from './projects.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"; // makes SVGs inert even when opened directly
const JSON_LIMIT = 1024 * 1024;
const COOKIE = 'sa_session';
const SESSION_SECONDS = 30 * 24 * 3600;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('request body is too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const parseCookies = (h) => Object.fromEntries((h ?? '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((p) => p[0]));

/**
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {string} o.token        admin token: bearer token for the API, password for the UI (required)
 * @param {{url:string, token?:string, retries?:number, baseDelayMs?:number}} [o.webhook] where uploaded images are pushed
 * @param {boolean} [o.publicFiles]  serve GET /files/<path> without authentication
 * @param {string} [o.host]
 * @param {number} [o.maxUploadBytes]
 * @param {string|null} [o.projectsDir]  folder of the other projects' databases (null: kept in memory)
 */
export function createServer({ db, token, webhook, publicFiles = false, host = '127.0.0.1', maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, projectsDir = null }) {
  if (!token) throw new Error('an admin token is required');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  // every project is its own database; the one the server was started with is the project "default"
  const projects = createProjects({ db, dir: projectsDir });
  const deliveries = new Map();
  const deliveryFor = (pid) => {
    if (!webhook?.url) return null;
    if (!deliveries.has(pid)) deliveries.set(pid, createDelivery({ ...webhook, project: pid }));
    return deliveries.get(pid);
  };
  const session = sessionCookieValue(token);
  const failures = new Map(); // ip -> {n, until} login throttle

  /** 'bearer' | 'cookie' | null */
  function authOf(req) {
    if (tokenOk(req.headers.authorization, token)) return 'bearer';
    const c = parseCookies(req.headers.cookie)[COOKIE];
    if (c && safeEqual(c, session)) return 'cookie';
    return null;
  }
  const secureCookie = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie(req) ? '; Secure' : ''}`;

  function sendImage(req, res, img) {
    const etag = `"${img.sha256}"`;
    const headers = { 'Content-Type': MIME[img.format], 'Content-Security-Policy': IMAGE_CSP, ETag: etag, 'Cache-Control': 'no-cache', 'X-Sprite-Sha256': img.sha256 };
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
    return send(res, 200, img.data, headers);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // DNS-rebinding guard when bound to loopback only.
      const hostName = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (loopback && !['localhost', '127.0.0.1', '::1'].includes(hostName)) return send(res, 403, { error: 'forbidden host' });
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /healthz') return send(res, 200, { ok: true });

      /* ----- images by path: GET /files/<path> ----- */
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/files/')) {
        if (!publicFiles && !authOf(req)) return send(res, 401, { error: 'authentication required' }, { 'WWW-Authenticate': 'Bearer' });
        let rel; try { rel = decodeURIComponent(url.pathname.slice('/files/'.length)); } catch { return send(res, 400, { error: 'bad path' }); }
        const first = rel.split('/')[0];
        const scoped = first !== DEFAULT_PROJECT ? projects.get(first) : null;
        const img = scoped ? getImage(scoped, { path: rel.slice(first.length + 1) }) : getImage(db, { path: rel });
        return img ? sendImage(req, res, img) : send(res, 404, { error: 'no image at this path' });
      }

      /* ----- API ----- */
      if (url.pathname.startsWith('/api/')) {
        if (route === 'POST /api/login') {
          const ip = req.socket.remoteAddress ?? '?';
          const f = failures.get(ip);
          if (f && f.n >= 10 && Date.now() < f.until) return send(res, 429, { error: 'too many attempts, wait a minute' });
          let body; try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (e) { if (e.status) throw e; body = {}; }
          if (typeof body?.token === 'string' && safeEqual(body.token, token)) {
            failures.delete(ip);
            return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, session, SESSION_SECONDS) });
          }
          failures.set(ip, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + 60_000 });
          return send(res, 401, { error: 'wrong token' });
        }
        if (route === 'POST /api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });

        const how = authOf(req);
        if (!how) return send(res, 401, { error: 'missing or invalid token' }, { 'WWW-Authenticate': 'Bearer' });
        // Cookies are sent by browsers automatically, so state-changing calls that rely on one need a header a cross-site page cannot set.
        if (how === 'cookie' && req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-sprite-admin'] !== '1') return send(res, 403, { error: 'missing X-Sprite-Admin header' });
        const id = url.searchParams.get('id') ?? '';
        const pid = url.searchParams.get('project') || req.headers['x-project'] || DEFAULT_PROJECT;
        const pdb = projects.get(pid);
        const noProject = () => send(res, 404, { ok: false, errors: [`unknown project "${pid}"`] });

        if (route === 'GET /api/projects') {
          return send(res, 200, { projects: projects.ids().map((p) => { const s = buildState(projects.get(p), p); return { id: p, name: s.project.name, description: s.project.description, ...s.summary }; }) });
        }
        if (route === 'DELETE /api/projects') {
          // deletes a project with everything in it; the default project is wiped empty instead
          if (!projects.wipe(id)) return send(res, 404, { ok: false, errors: [`unknown project "${id}"`] });
          deliveries.delete(id);
          return send(res, 200, { ok: true, project: id, wiped: id === DEFAULT_PROJECT });
        }

        if (route === 'POST /api/requests') {
          let payload;
          try { payload = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8')); } catch (e) { if (e.status) throw e; return send(res, 400, { ok: false, errors: ['body is not valid JSON'], warnings: [] }); }
          const v = validateRequest(payload);
          if (v.errors.length) return send(res, 422, { ok: false, errors: v.errors, warnings: v.warnings });
          // a request that names a project creates it; without a name it goes to the project of ?project= (default: the default one)
          const { id: named, ...info } = v.project ?? {};
          const target = named ?? pid;
          let tdb = projects.get(target);
          const created = !tdb && !!named;
          if (!tdb) { if (!named) return noProject(); tdb = projects.ensure(target); }
          const r = applyRequest(tdb, { ...v, project: Object.keys(info).length ? info : null });
          if (!r.ok && created) projects.remove(target); // a refused request must not leave an empty project behind
          return send(res, r.ok ? 200 : 422, { ...r, project: target, warnings: v.warnings });
        }

        if (!pdb) return noProject();

        if (route === 'GET /api/state') {
          const state = buildState(pdb, pid);
          const delivery = deliveryFor(pid);
          if (delivery) state.delivery = delivery.status();
          return send(res, 200, state);
        }

        if (route === 'DELETE /api/sprites') {
          const r = deleteSprite(pdb, id);
          return send(res, r.status, r);
        }

        if (route === 'POST /api/upload') {
          const buf = await readBody(req, maxUploadBytes);
          const r = saveImage(pdb, id, buf, maxUploadBytes);
          const delivery = deliveryFor(pid);
          if (r.ok && delivery) delivery.deliver(r.event, buf, MIME[r.event.format]);
          const { event, ...rest } = r;
          return send(res, r.status, rest);
        }

        if (route === 'GET /api/file') {
          const img = getImage(pdb, { id, history: Number(url.searchParams.get('history')) || undefined });
          return img ? sendImage(req, res, img) : send(res, 404, { error: 'no image' });
        }

        if (route === 'GET /api/history') return send(res, 200, { versions: listHistory(pdb, id) });

        if (route === 'GET /api/events') {
          const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
          const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          return send(res, 200, { events: listEvents(pdb, since, limit).map((e) => ({ ...e, project: pid })) });
        }
        return send(res, 404, { error: 'not found' });
      }

      /* ----- the admin UI (static, contains no data) ----- */
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      return send(res, 200, fs.readFileSync(file), { 'Content-Type': STATIC_MIME[path.extname(file)] ?? 'application/octet-stream' });
    } catch (e) {
      return send(res, e.status ?? 500, { ok: false, errors: [e.status ? e.message : 'server error'] });
    }
  });
  server.on('close', () => projects.close());
  return server;
}
