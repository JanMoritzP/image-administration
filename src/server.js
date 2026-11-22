import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract } from './contract.js';
import { evaluateContract } from './status.js';
import { acceptUpload, syncTargets, MAX_UPLOAD_BYTES } from './store.js';
import { MIME } from './formats.js';
import { probeImage } from './images.js';
import { tokenOk, sha256, submitRequests, readEvents, appendEvent, createDelivery } from './integration.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('file is too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Endpoints for the plugin / other servers. They need a bearer token and are disabled when none is configured.
const PLUGIN_ROUTES = new Set(['/api/requests', '/api/events', '/api/file']);
const JSON_LIMIT = 1024 * 1024;

/**
 * @param {string} input path to the manifest file or the directory that holds it
 * @param {{host?: string, token?: string, webhook?: {url: string, token?: string, retries?: number, baseDelayMs?: number}}} [opts]
 *   token: bearer token for the plugin API; webhook: where every delivered image is pushed to
 */
export function createServer(input, { host = '127.0.0.1', token, webhook } = {}) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const fresh = () => loadContract(input);
  const delivery = webhook?.url ? createDelivery(webhook) : null;
  const eventsFile = (c) => path.join(c.root, '.sprite-admin', 'events.jsonl');
  const firstFile = (c, id) => c.sprites.find((s) => s.id === id)?.targets.find((t) => fs.existsSync(t.abs));

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // DNS-rebinding guard when bound to loopback only.
      const hostName = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (loopback && !['localhost', '127.0.0.1', '::1'].includes(hostName)) return send(res, 403, { error: 'forbidden host' });

      if (url.pathname.startsWith('/api/')) {
        if (PLUGIN_ROUTES.has(url.pathname)) {
          if (!token) return send(res, 503, { error: 'plugin API is disabled: start the server with --token or SPRITE_ADMIN_TOKEN' });
          if (!tokenOk(req.headers.authorization, token)) return send(res, 401, { error: 'missing or invalid bearer token' }, { 'WWW-Authenticate': 'Bearer' });
        } else if (req.method === 'POST' && req.headers['x-sprite-admin'] !== '1') return send(res, 403, { error: 'missing X-Sprite-Admin header' });
        const id = url.searchParams.get('id') ?? '';

        if (req.method === 'GET' && url.pathname === '/api/state') {
          const state = evaluateContract(fresh());
          if (delivery) state.delivery = delivery.status();
          return send(res, 200, state);
        }

        if (req.method === 'POST' && url.pathname === '/api/requests') {
          const manifest = fresh().manifest;
          if (!manifest) return send(res, 500, { ok: false, errors: ['no contract manifest'] });
          let payload;
          try { payload = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8')); } catch (e) { if (e.status) throw e; return send(res, 400, { ok: false, errors: ['body is not valid JSON'] }); }
          const r = submitRequests(manifest, payload);
          return send(res, r.status, r);
        }

        if (req.method === 'GET' && url.pathname === '/api/events') {
          const c = fresh();
          if (!c.root) return send(res, 500, { error: 'contract could not be loaded' });
          const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
          const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          return send(res, 200, { events: readEvents(eventsFile(c), since, limit) });
        }

        if (req.method === 'GET' && url.pathname === '/api/file') {
          const target = firstFile(fresh(), id);
          if (!target) return send(res, 404, { error: 'no image' });
          const buf = fs.readFileSync(target.abs);
          return send(res, 200, buf, { 'Content-Type': MIME[target.format], 'X-Sprite-Sha256': sha256(buf), 'Content-Security-Policy': "default-src 'none'; sandbox" });
        }

        if (req.method === 'GET' && url.pathname === '/api/image') {
          const target = firstFile(fresh(), id);
          if (!target) return send(res, 404, { error: 'no image' });
          return send(res, 200, fs.readFileSync(target.abs), { 'Content-Type': MIME[target.format], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        }

        if (req.method === 'POST' && url.pathname === '/api/upload') {
          const buf = await readBody(req, MAX_UPLOAD_BYTES);
          const c = fresh();
          const r = acceptUpload(c, id, buf);
          if (r.ok) {
            const info = probeImage(buf);
            const event = appendEvent(eventsFile(c), { type: 'image.delivered', id, format: info.format, width: info.width, height: info.height, bytes: buf.length, sha256: sha256(buf), targets: c.sprites.find((s) => s.id === id).targets.map((t) => t.path) });
            delivery?.deliver(event, buf, MIME[info.format]);
          }
          return send(res, r.status, r);
        }

        if (req.method === 'POST' && url.pathname === '/api/sync') {
          const r = syncTargets(fresh(), id);
          return send(res, r.status, r);
        }
        return send(res, 404, { error: 'not found' });
      }

      // static files
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      return send(res, 200, fs.readFileSync(file), { 'Content-Type': STATIC_MIME[path.extname(file)] ?? 'application/octet-stream' });
    } catch (e) {
      return send(res, e.status ?? 500, { ok: false, errors: [e.message ?? 'server error'] });
    }
  });
}
