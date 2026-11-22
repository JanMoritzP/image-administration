// Token auth helpers and webhook delivery of uploaded images to the plugin.
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest();

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) { return crypto.timingSafeEqual(sha(String(a)), sha(String(b))); }

/** Value of the session cookie that proves the admin token was entered (never the token itself). */
export const sessionCookieValue = (token) => crypto.createHash('sha256').update(`sprite-admin-session:${token}`).digest('hex');

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return !!(m && token && safeEqual(m[1], token));
}

/* ---------- webhook delivery ---------- */

/**
 * POSTs each delivered image (raw bytes) to the plugin, retrying with exponential backoff.
 * Per sprite id the latest attempt is exposed via `status` so the UI/API can show it.
 */
export function createDelivery({ url, token, project = 'default', retries = 5, baseDelayMs = 1000, timeoutMs = 15000 }) {
  const status = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function deliver(event, buf, mime) {
    const rec = { seq: event.seq, status: 'pending', attempts: 0, error: null, at: event.at };
    status.set(event.id, rec);
    const headers = {
      'Content-Type': mime,
      'X-Sprite-Event': event.type,
      'X-Sprite-Project': project,
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
