// Delivers uploads to every target a sprite declares (validated first, written atomically, old files backed up).
import fs from 'node:fs';
import path from 'node:path';
import { probeImage, checkSpec } from './images.js';
import { inspectFile, evaluateSprite } from './status.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function writeAtomic(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
}

function backup(contract, sprite, runStamp) {
  if (!contract.project.backups) return;
  for (const t of sprite.targets) {
    if (!fs.existsSync(t.abs)) continue;
    const dest = path.join(contract.root, '.sprite-admin', 'backups', runStamp, t.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(t.abs, dest);
  }
}

function insideRoot(contract, abs) {
  const rel = path.relative(contract.root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** @returns {{ok:boolean, status:number, errors:string[], warnings:string[], sprite?:object}} */
export function acceptUpload(contract, id, buf) {
  const sprite = contract.sprites.find((s) => s.id === id);
  if (!sprite) return { ok: false, status: 404, errors: [`unknown sprite id "${id}"`], warnings: [] };
  if (!buf.length) return { ok: false, status: 400, errors: ['empty upload'], warnings: [] };
  if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, status: 413, errors: ['file is too large'], warnings: [] };
  const info = probeImage(buf);
  if (!info) return { ok: false, status: 422, errors: ['this is not a PNG, JPEG, GIF, WebP or SVG image'], warnings: [] };

  const issues = checkSpec(info, sprite.spec);
  const errors = issues.filter((i) => i.level === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.level === 'warn').map((i) => i.message);
  for (const t of sprite.targets) {
    if (t.format !== info.format) errors.push(`target ${t.path} needs a ${t.format.toUpperCase()} file but you uploaded ${info.format.toUpperCase()}`);
    if (!insideRoot(contract, t.abs)) errors.push(`target ${t.path} is outside the project root`);
  }
  if (errors.length) return { ok: false, status: 422, errors, warnings };

  const runStamp = stamp();
  backup(contract, sprite, runStamp);
  for (const t of sprite.targets) writeAtomic(t.abs, buf);
  return { ok: true, status: 200, errors: [], warnings, sprite: evaluateSprite(sprite) };
}

/** Copy the first valid existing target to all other targets. */
export function syncTargets(contract, id) {
  const sprite = contract.sprites.find((s) => s.id === id);
  if (!sprite) return { ok: false, status: 404, errors: [`unknown sprite id "${id}"`], warnings: [] };
  const evald = evaluateSprite(sprite);
  const srcIdx = evald.targets.findIndex((t) => t.exists && !t.issues.some((i) => i.level === 'error'));
  if (srcIdx < 0) return { ok: false, status: 422, errors: ['no valid file exists to copy from'], warnings: [] };
  const src = sprite.targets[srcIdx];
  const buf = fs.readFileSync(src.abs);
  const todo = sprite.targets.filter((t, i) => i !== srcIdx && (!evald.targets[i].exists || evald.targets[i].issues.some((x) => x.level === 'error')));
  const bad = todo.filter((t) => t.format !== src.format);
  if (bad.length) return { ok: false, status: 422, errors: bad.map((t) => `${t.path} is ${t.format.toUpperCase()} but the source is ${src.format.toUpperCase()}; upload a ${t.format.toUpperCase()} file instead`), warnings: [] };
  const runStamp = stamp();
  backup(contract, { targets: todo }, runStamp);
  for (const t of todo) writeAtomic(t.abs, buf);
  inspectFile(src.abs);
  return { ok: true, status: 200, errors: [], warnings: [], sprite: evaluateSprite(sprite) };
}
