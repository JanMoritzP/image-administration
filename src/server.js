import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract } from './contract.js';
import { evaluateContract } from './status.js';
import { acceptUpload, syncTargets, MAX_UPLOAD_BYTES } from './store.js';
import { MIME } from './formats.js';

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

/** @param {string} input path to the manifest file or the directory that holds it */
export function createServer(input, { host = '127.0.0.1' } = {}) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const fresh = () => loadContract(input);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // DNS-rebinding guard when bound to loopback only.
      const hostName = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (loopback && !['localhost', '127.0.0.1', '::1'].includes(hostName)) return send(res, 403, { error: 'forbidden host' });

      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST' && req.headers['x-sprite-admin'] !== '1') return send(res, 403, { error: 'missing X-Sprite-Admin header' });
        const id = url.searchParams.get('id') ?? '';

        if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, evaluateContract(fresh()));

        if (req.method === 'GET' && url.pathname === '/api/image') {
          const c = fresh();
          const sprite = c.sprites.find((s) => s.id === id);
          const target = sprite?.targets.find((t) => fs.existsSync(t.abs));
          if (!target) return send(res, 404, { error: 'no image' });
          return send(res, 200, fs.readFileSync(target.abs), { 'Content-Type': MIME[target.format], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        }

        if (req.method === 'POST' && url.pathname === '/api/upload') {
          const buf = await readBody(req, MAX_UPLOAD_BYTES);
          const r = acceptUpload(fresh(), id, buf);
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
