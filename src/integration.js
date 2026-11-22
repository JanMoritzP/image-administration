// Plugin integration: remote contract requests, a persistent event log and webhook delivery of uploaded images.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadContract, SPEC_VERSION, PLUGIN_FILE } from './contract.js';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, errors, extra = {}) => ({ ok: false, status, errors, warnings: [], ...extra });

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m || !token) return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(m[1]), h(token));
}

/* ---------- contract requests ---------- */

/**
 * Adds (or, by sprite id, replaces) sprites/folders in the plugin requests file. The result is validated by loading the
 * whole contract; if the plugin's file introduced errors, the file is restored and nothing changes.
 */
export function submitRequests(manifest, payload) {
  if (!isObj(payload)) return fail(400, ['body must be a JSON object: {"sprites": [...], "folders": {...}}']);
  const sprites = payload.sprites ?? [];
  const folders = payload.folders ?? {};
  if (!Array.isArray(sprites) || !isObj(folders)) return fail(400, ['"sprites" must be a list and "folders" a mapping']);
  if (!sprites.length && !Object.keys(folders).length) return fail(400, ['nothing to add']);
  if (sprites.some((s) => !isObj(s) || typeof s.id !== 'string' || !s.id)) return fail(400, ['every sprite needs a string "id"']);

  const file = path.join(path.dirname(manifest), PLUGIN_FILE);
  let previous = null;
  let doc = { contract: SPEC_VERSION, folders: {}, sprites: [] };
  if (fs.existsSync(file)) {
    previous = fs.readFileSync(file, 'utf8');
    try {
      const p = JSON.parse(previous);
      if (!isObj(p)) throw new Error('not an object');
      doc = { contract: SPEC_VERSION, folders: isObj(p.folders) ? p.folders : {}, sprites: Array.isArray(p.sprites) ? p.sprites : [] };
    } catch (e) { return fail(409, [`${PLUGIN_FILE} exists but cannot be read (${e.message}); fix or delete it first`]); }
  }

  Object.assign(doc.folders, folders);
  for (const s of sprites) {
    const i = doc.sprites.findIndex((x) => x?.id === s.id);
    if (i >= 0) doc.sprites[i] = s; else doc.sprites.push(s);
  }

  const write = (text) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };
  write(JSON.stringify(doc, null, 2) + '\n');
  const c = loadContract(manifest);
  const mine = c.diagnostics.filter((d) => path.resolve(d.file) === path.resolve(file));
  const errors = mine.filter((d) => d.level === 'error');
  if (errors.length) {
    if (previous === null) fs.unlinkSync(file); else write(previous);
    return fail(422, errors.map((d) => `${d.pointer || '/'}: ${d.message}`));
  }
  const warnings = mine.filter((d) => d.level === 'warning').map((d) => `${d.pointer || '/'}: ${d.message}`);
  const ids = c.sprites.filter((s) => s.source === PLUGIN_FILE).map((s) => s.id);
  return { ok: true, status: 200, errors: [], warnings, sprites: ids };
}

/* ---------- event log (append-only JSON lines, used for catch-up polling) ---------- */

export function readEvents(file, since = 0, limit = 100) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.seq > since) { out.push(e); if (out.length >= limit) break; }
  }
  return out;
}

export function appendEvent(file, event) {
  let seq = 0;
  for (const e of readEvents(file, 0, Infinity)) seq = Math.max(seq, e.seq);
  const e = { seq: seq + 1, at: new Date().toISOString(), ...event };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(e) + '\n');
  return e;
}

/* ---------- webhook delivery ---------- */

/**
 * POSTs each delivered image (raw bytes) to the plugin, retrying with exponential backoff.
 * Per sprite id the latest attempt is exposed via `status` so the UI/API can show it.
 */
export function createDelivery({ url, token, retries = 5, baseDelayMs = 1000, timeoutMs = 15000 }) {
  const status = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function deliver(event, buf, mime) {
    const rec = { seq: event.seq, status: 'pending', attempts: 0, error: null, at: event.at };
    status.set(event.id, rec);
    const headers = {
      'Content-Type': mime,
      'X-Sprite-Event': event.type,
      'X-Sprite-Id': event.id,
      'X-Sprite-Seq': String(event.seq),
      'X-Sprite-Sha256': event.sha256,
      'X-Sprite-Format': event.format,
      ...(event.width != null && event.height != null ? { 'X-Sprite-Width': String(event.width), 'X-Sprite-Height': String(event.height) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    for (let i = 0; i < retries; i++) {
      rec.attempts++;
      try {
        const r = await fetch(url, { method: 'POST', headers, body: buf, signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) { rec.status = 'delivered'; rec.error = null; return; }
        rec.error = `HTTP ${r.status}`;
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) break; // the plugin rejected it: retrying won't help
      } catch (e) { rec.error = e.message; }
      if (i < retries - 1) await sleep(baseDelayMs * 2 ** i);
    }
    rec.status = 'failed';
  }

  return { deliver, status: () => Object.fromEntries(status) };
}
