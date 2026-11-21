// Evaluates a loaded contract against the file system: which sprites exist, which are valid.
import fs from 'node:fs';
import { probeImage, checkSpec, formatOfPath } from './images.js';

const probeCache = new Map(); // abs -> {mtimeMs,size,info}

export function inspectFile(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = probeCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { ...hit.data };
  const buf = fs.readFileSync(abs);
  const info = probeImage(buf);
  const data = { mtimeMs: st.mtimeMs, bytes: st.size, info };
  probeCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, data });
  return { ...data };
}

export function evaluateTarget(target, spec) {
  const f = inspectFile(target.abs);
  const base = { path: target.path, ...(target.label ? { label: target.label } : {}) };
  if (!f) return { ...base, exists: false, issues: [] };
  const issues = [];
  let out = { ...base, exists: true, bytes: f.bytes, mtime: Math.round(f.mtimeMs) };
  if (!f.info) {
    issues.push({ level: 'error', code: 'not-an-image', message: 'file exists but is not a recognizable PNG/JPEG/GIF/WebP/SVG image' });
  } else {
    out = { ...out, format: f.info.format, width: f.info.width, height: f.info.height, alpha: f.info.alpha };
    const want = formatOfPath(target.path);
    if (want && want !== f.info.format) issues.push({ level: 'error', code: 'format-ext-mismatch', message: `file content is ${f.info.format.toUpperCase()} but the path ends in .${target.path.split('.').pop()}` });
    issues.push(...checkSpec(f.info, spec));
  }
  return { ...out, issues };
}

export function evaluateSprite(sprite) {
  const targets = sprite.targets.map((t) => evaluateTarget(t, sprite.spec));
  const present = targets.filter((t) => t.exists);
  const hasError = present.some((t) => t.issues.some((i) => i.level === 'error'));
  let status;
  if (!present.length) status = 'missing';
  else if (hasError) status = 'invalid';
  else if (present.length < targets.length) status = 'partial';
  else status = 'available';
  const issues = targets.flatMap((t) => t.issues.map((i) => ({ ...i, target: t.path })));
  if (status === 'partial') for (const t of targets.filter((x) => !x.exists)) issues.push({ level: 'error', code: 'target-missing', target: t.path, message: 'this target has no file yet (use "Sync targets" or upload again)' });
  return {
    id: sprite.id, folder: sprite.folder, name: sprite.name, title: sprite.title, description: sprite.description,
    required: sprite.required, tags: sprite.tags, notes: sprite.notes, reference: sprite.reference, spec: sprite.spec,
    source: sprite.source, status, targets, issues,
    version: Math.max(0, ...present.map((t) => t.mtime)),
  };
}

const pct = (done, total) => (total ? Math.round((100 * done) / total) : 0);
const tally = () => ({ total: 0, done: 0, missing: 0, partial: 0, invalid: 0, requiredTotal: 0, requiredDone: 0, percent: 0 });

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

export function evaluateContract(contract) {
  const sprites = contract.sprites.map(evaluateSprite);
  const summary = tally();
  const folderStats = new Map(contract.folders.map((f) => [f.id, tally()]));
  for (const sp of sprites) {
    add(summary, sp);
    const segs = sp.folder ? sp.folder.split('/') : [];
    segs.forEach((_, i) => add(folderStats.get(segs.slice(0, i + 1).join('/')), sp));
  }
  return {
    report: '1.0',
    contract: { version: '1.0', manifest: contract.manifest, root: contract.root, files: contract.files },
    project: contract.project,
    generatedAt: new Date().toISOString(),
    summary: finish(summary),
    folders: contract.folders.map((f) => ({ ...f, ...finish(folderStats.get(f.id)) })),
    sprites,
    diagnostics: contract.diagnostics,
    ok: contract.ok,
    fatal: contract.fatal,
  };
}
