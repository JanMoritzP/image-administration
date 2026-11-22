// All writes and lookups: requested sprites, uploaded images, deletion, change events.
import crypto from 'node:crypto';
import { tx } from './db.js';
import { probeImage, checkSpec, formatOfPath } from './images.js';
import { loadSprites } from './status.js';

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const HISTORY_KEEP = 5;

const now = () => new Date().toISOString();
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
class Rollback extends Error { constructor(errors) { super('rollback'); this.errors = errors; } }

function logEvent(db, ev) {
  const at = now();
  const r = db.prepare('INSERT INTO events (at, type, sprite_id, format, width, height, bytes, sha256, targets) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(at, ev.type, ev.id, ev.format ?? null, ev.width ?? null, ev.height ?? null, ev.bytes ?? null, ev.sha256 ?? null, JSON.stringify(ev.targets ?? []));
  return { seq: Number(r.lastInsertRowid), at, ...ev };
}

export function listEvents(db, since = 0, limit = 100) {
  return db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit).map((e) => ({
    seq: e.seq, at: e.at, type: e.type, id: e.sprite_id,
    ...(e.format ? { format: e.format, width: e.width, height: e.height, bytes: e.bytes, sha256: e.sha256 } : {}),
    targets: JSON.parse(e.targets),
  }));
}

/**
 * Applies a validated request (see validate.js): project info, folders and sprites are added, sprites with an existing id
 * are replaced (their image is kept). All or nothing. Returns {ok, errors, sprites}.
 */
export function applyRequest(db, req) {
  try {
    return tx(db, () => {
      const t = now();
      if (req.project) for (const [k, v] of Object.entries(req.project)) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
      for (const f of req.folders) db.prepare('INSERT INTO folders (id, title, description, icon) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, icon = excluded.icon').run(f.id, f.title, f.description, f.icon);
      // free the paths of every sprite in this batch first, so sprites may swap or move paths within one request
      for (const s of req.sprites) db.prepare('DELETE FROM targets WHERE sprite_id = ?').run(s.id);
      const errors = [];
      req.sprites.forEach((s) => {
        db.prepare(`INSERT INTO sprites (id, title, description, required, tags, notes, spec, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, required = excluded.required, tags = excluded.tags, notes = excluded.notes, spec = excluded.spec, updated_at = excluded.updated_at`)
          .run(s.id, s.title, s.description, s.required ? 1 : 0, JSON.stringify(s.tags), s.notes, JSON.stringify(s.spec), t, t);
        s.targets.forEach((tg, i) => {
          const owner = db.prepare('SELECT sprite_id FROM targets WHERE path = ?').get(tg.path);
          if (owner) errors.push(`target "${tg.path}" of "${s.id}" is already used by sprite "${owner.sprite_id}"`);
          else db.prepare('INSERT INTO targets (path, sprite_id, label, position) VALUES (?,?,?,?)').run(tg.path, s.id, tg.label ?? null, i);
        });
      });
      if (errors.length) throw new Rollback(errors);
      return { ok: true, errors: [], sprites: req.sprites.map((s) => s.id) };
    });
  } catch (e) {
    if (e instanceof Rollback) return { ok: false, errors: e.errors, sprites: [] };
    throw e;
  }
}

export function deleteSprite(db, id) {
  return tx(db, () => {
    const targets = db.prepare('SELECT path FROM targets WHERE sprite_id = ?').all(id).map((r) => r.path);
    const r = db.prepare('DELETE FROM sprites WHERE id = ?').run(id);
    if (!r.changes) return { ok: false, status: 404, errors: [`unknown sprite id "${id}"`] };
    logEvent(db, { type: 'sprite.deleted', id, targets });
    return { ok: true, status: 200, errors: [] };
  });
}

/**
 * Validates an uploaded image against the sprite's spec and stores it.
 * @returns {{ok:boolean,status:number,errors:string[],warnings:string[],event?:object,sprite?:object}}
 */
export function saveImage(db, id, buf, maxBytes = DEFAULT_MAX_UPLOAD_BYTES) {
  const row = db.prepare('SELECT * FROM sprites WHERE id = ?').get(id);
  const fail = (status, ...errors) => ({ ok: false, status, errors, warnings: [] });
  if (!row) return fail(404, `unknown sprite id "${id}"`);
  if (!buf.length) return fail(400, 'empty upload');
  if (buf.length > maxBytes) return fail(413, 'file is too large');
  const info = probeImage(buf);
  if (!info) return fail(422, 'this is not a PNG, JPEG, GIF, WebP or SVG image');

  const spec = JSON.parse(row.spec);
  const issues = checkSpec(info, spec);
  const errors = issues.filter((i) => i.level === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.level === 'warn').map((i) => i.message);
  const targets = db.prepare('SELECT path FROM targets WHERE sprite_id = ? ORDER BY position').all(id).map((t) => t.path);
  for (const p of targets) {
    const want = formatOfPath(p);
    if (want !== info.format) errors.push(`${p} needs a ${want.toUpperCase()} file but you uploaded ${info.format.toUpperCase()}`);
  }
  if (errors.length) return { ok: false, status: 422, errors, warnings };

  const event = tx(db, () => {
    const t = now();
    const old = db.prepare('SELECT * FROM images WHERE sprite_id = ?').get(id);
    if (old) {
      db.prepare('INSERT INTO image_history (sprite_id, data, format, width, height, bytes, sha256, uploaded_at, replaced_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, old.data, old.format, old.width, old.height, old.bytes, old.sha256, old.updated_at, t);
      db.prepare('DELETE FROM image_history WHERE sprite_id = ? AND id NOT IN (SELECT id FROM image_history WHERE sprite_id = ? ORDER BY id DESC LIMIT ?)').run(id, id, HISTORY_KEEP);
    }
    const hash = sha256(buf);
    db.prepare(`INSERT INTO images (sprite_id, data, format, width, height, alpha, bytes, sha256, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sprite_id) DO UPDATE SET data = excluded.data, format = excluded.format, width = excluded.width, height = excluded.height, alpha = excluded.alpha, bytes = excluded.bytes, sha256 = excluded.sha256, updated_at = excluded.updated_at`)
      .run(id, buf, info.format, info.width, info.height, info.alpha == null ? null : info.alpha ? 1 : 0, buf.length, hash, t);
    return logEvent(db, { type: 'image.delivered', id, format: info.format, width: info.width, height: info.height, bytes: buf.length, sha256: hash, targets });
  });
  return { ok: true, status: 200, errors: [], warnings, event, sprite: loadSprites(db, id)[0] };
}

/** Finds an image by sprite id or by one of its target paths. `history` selects an older version (image_history.id). */
export function getImage(db, { id, path, history }) {
  if (history) {
    const sprite = id ?? db.prepare('SELECT sprite_id FROM targets WHERE path = ?').get(path)?.sprite_id;
    const r = db.prepare('SELECT * FROM image_history WHERE id = ? AND sprite_id = ?').get(history, sprite);
    return r ? { data: Buffer.from(r.data), format: r.format, sha256: r.sha256 } : null;
  }
  const r = id
    ? db.prepare('SELECT data, format, sha256 FROM images WHERE sprite_id = ?').get(id)
    : db.prepare('SELECT i.data, i.format, i.sha256 FROM targets t JOIN images i ON i.sprite_id = t.sprite_id WHERE t.path = ?').get(path);
  return r ? { data: Buffer.from(r.data), format: r.format, sha256: r.sha256 } : null;
}

export function listHistory(db, id) {
  return db.prepare('SELECT id AS version, format, width, height, bytes, sha256, uploaded_at AS uploadedAt, replaced_at AS replacedAt FROM image_history WHERE sprite_id = ? ORDER BY id DESC').all(id);
}
