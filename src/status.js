// Builds the status report from the database: which sprites have a valid image, which are missing or invalid.
import { checkSpec, formatOfPath } from './images.js';

const pct = (done, total) => (total ? Math.round((100 * done) / total) : 0);
const tally = () => ({ total: 0, done: 0, missing: 0, invalid: 0, requiredTotal: 0, requiredDone: 0, percent: 0 });
const humanize = (s) => s.replace(/[-_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function add(t, sp) {
  t.total++;
  if (sp.status === 'available') t.done++; else t[sp.status]++;
  if (sp.required) { t.requiredTotal++; if (sp.status === 'available') t.requiredDone++; }
}
function finish(t) {
  // Progress counts required sprites; if a scope has none, optional sprites count so the bar is never empty by accident.
  t.percent = t.requiredTotal ? pct(t.requiredDone, t.requiredTotal) : pct(t.done, t.total);
  return t;
}

function evaluate(row, targets, img) {
  const spec = JSON.parse(row.spec);
  const segs = row.id.split('/');
  let status = 'missing'; let issues = [];
  if (img) {
    issues = checkSpec({ format: img.format, width: img.width, height: img.height, alpha: img.alpha == null ? null : !!img.alpha, bytes: img.bytes }, spec);
    for (const t of targets) {
      const want = formatOfPath(t.path);
      if (want && want !== img.format) issues.push({ level: 'error', code: 'format-ext-mismatch', message: `the stored image is ${img.format.toUpperCase()} but ${t.path} needs ${want.toUpperCase()}; upload again` });
    }
    status = issues.some((i) => i.level === 'error') ? 'invalid' : 'available';
  }
  return {
    id: row.id, folder: segs.slice(0, -1).join('/'), name: segs.at(-1), title: row.title, description: row.description,
    required: !!row.required, tags: JSON.parse(row.tags), notes: row.notes, spec, status, issues,
    targets: targets.map((t) => ({ path: t.path, ...(t.label ? { label: t.label } : {}), url: `/files/${t.path}` })),
    image: img ? { format: img.format, width: img.width, height: img.height, alpha: img.alpha == null ? null : !!img.alpha, bytes: img.bytes, sha256: img.sha256, updatedAt: img.updated_at } : null,
    version: img ? Date.parse(img.updated_at) : 0,
  };
}

const IMG_COLS = 'sprite_id, format, width, height, alpha, bytes, sha256, updated_at'; // everything except the blob

/** All sprites (or just `onlyId`) with their evaluated status. */
export function loadSprites(db, onlyId) {
  const where = onlyId ? 'WHERE id = ?' : '';
  const args = onlyId ? [onlyId] : [];
  const rows = db.prepare(`SELECT * FROM sprites ${where} ORDER BY rowid`).all(...args);
  const targets = new Map(); const images = new Map();
  for (const t of db.prepare(`SELECT * FROM targets ${onlyId ? 'WHERE sprite_id = ?' : ''} ORDER BY position`).all(...args)) (targets.get(t.sprite_id) ?? targets.set(t.sprite_id, []).get(t.sprite_id)).push(t);
  for (const i of db.prepare(`SELECT ${IMG_COLS} FROM images ${onlyId ? 'WHERE sprite_id = ?' : ''}`).all(...args)) images.set(i.sprite_id, i);
  return rows.map((r) => evaluate(r, targets.get(r.id) ?? [], images.get(r.id)));
}

export function buildState(db, projectId = 'default') {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  const sprites = loadSprites(db);
  const declared = new Map(db.prepare('SELECT * FROM folders ORDER BY rowid').all().map((f) => [f.id, f]));

  // Folder tree: declared folders and every ancestor of a sprite's folder, children right after their parent.
  const seen = new Map();
  const touch = (id) => {
    if (id.includes('/')) touch(id.slice(0, id.lastIndexOf('/')));
    if (seen.has(id)) return;
    const f = declared.get(id);
    seen.set(id, { id, title: f?.title ?? humanize(id.split('/').pop()), description: f?.description ?? '', icon: f?.icon ?? '', depth: id.split('/').length });
  };
  for (const id of declared.keys()) touch(id);
  for (const sp of sprites) if (sp.folder) touch(sp.folder);
  const all = [...seen.values()]; const ordered = [];
  const parentOf = (id) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
  const walk = (parent) => all.filter((f) => parentOf(f.id) === parent).forEach((f) => { ordered.push(f); walk(f.id); });
  walk('');

  const summary = tally();
  const stats = new Map(ordered.map((f) => [f.id, tally()]));
  for (const sp of sprites) {
    add(summary, sp);
    const segs = sp.folder ? sp.folder.split('/') : [];
    segs.forEach((_, i) => add(stats.get(segs.slice(0, i + 1).join('/')), sp));
  }
  return {
    project: { id: projectId, name: meta.name ?? (projectId === 'default' ? 'Image Administration' : projectId), description: meta.description ?? '' },
    generatedAt: new Date().toISOString(),
    summary: finish(summary),
    folders: ordered.map((f) => ({ ...f, ...finish(stats.get(f.id)) })),
    sprites,
  };
}
