// Sprite Contract loader: reads the manifest + included files, layers defaults, expands matrices,
// validates everything and returns normalized sprites plus diagnostics. Never throws on bad content.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { FORMATS, EXT_FORMAT } from './formats.js';

export const SPEC_VERSION = '1.0';
export const MANIFEST_NAMES = ['sprites.contract.yml', 'sprites.contract.yaml', 'sprites.contract.json'];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;
const VAR_RE = /^[a-z][a-z0-9_]*$/;
const RESERVED_VARS = ['id', 'name', 'folder'];
const MAX_COMBOS = 5000;

const KEYS = {
  root: ['$schema', 'contract', 'project', 'include', 'defaults', 'folders', 'sprites'],
  included: ['$schema', 'contract', 'include', 'defaults', 'folders', 'sprites'],
  project: ['name', 'description', 'root', 'backups'],
  defaults: ['spec', 'target', 'targets', 'required', 'tags', 'notes'],
  folder: ['title', 'description', 'icon', 'defaults'],
  sprite: ['id', 'title', 'description', 'required', 'tags', 'notes', 'reference', 'spec', 'target', 'targets', 'matrix'],
  spec: ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'aspect', 'multipleOf', 'formats', 'alpha', 'maxBytes', 'strict'],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const ptrJoin = (p, k) => `${p}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;

class Diags {
  list = [];
  add(level, code, file, pointer, message) { this.list.push({ level, code, file, pointer, message }); }
  error(code, file, pointer, message) { this.add('error', code, file, pointer, message); }
  warn(code, file, pointer, message) { this.add('warning', code, file, pointer, message); }
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function checkKeys(obj, allowed, file, ptr, d) {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    const near = allowed.map((a) => [a, lev(a.toLowerCase(), k.toLowerCase())]).sort((x, y) => x[1] - y[1])[0];
    d.warn('unknown-key', file, ptrJoin(ptr, k), `unknown key "${k}" is ignored${near && near[1] <= 2 ? ` (did you mean "${near[0]}"?)` : ''}`);
  }
}

export function findManifest(input) {
  const p = path.resolve(input ?? '.');
  if (!fs.existsSync(p)) return null;
  if (fs.statSync(p).isFile()) return p;
  for (const n of MANIFEST_NAMES) if (fs.existsSync(path.join(p, n))) return path.join(p, n);
  return null;
}

function readDoc(file, d) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { d.error('file-unreadable', file, '', e.message); return null; }
  let doc;
  try { doc = file.toLowerCase().endsWith('.json') ? JSON.parse(text) : YAML.parse(text); }
  catch (e) { d.error('parse-error', file, '', String(e.message).split('\n')[0]); return null; }
  if (!isObj(doc)) { d.error('invalid-type', file, '', 'the document must be a mapping/object at the top level'); return null; }
  return doc;
}

/* ---------- glob (for `include`) ---------- */
const hasGlob = (s) => /[*?]/.test(s);
function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; } }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function expandGlob(baseDir, pattern) {
  const segs = pattern.split('/');
  const staticSegs = [];
  for (const s of segs) { if (hasGlob(s)) break; staticSegs.push(s); }
  const start = path.resolve(baseDir, staticSegs.join('/'));
  const re = globToRegex(pattern);
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (re.test(path.relative(baseDir, full).split(path.sep).join('/'))) out.push(full);
    }
  };
  walk(start);
  return out.sort();
}

/* ---------- layer cleaning ---------- */
function cleanSpec(spec, file, ptr, d) {
  if (!isObj(spec)) { d.error('invalid-type', file, ptr, '"spec" must be a mapping'); return null; }
  checkKeys(spec, KEYS.spec, file, ptr, d);
  const out = {};
  const errorsBefore = d.list.length;
  for (const [k, v] of Object.entries(spec)) {
    const p = ptrJoin(ptr, k);
    if (!KEYS.spec.includes(k)) continue;
    if (['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'multipleOf', 'maxBytes'].includes(k)) {
      if (!isPosInt(v)) d.error('invalid-value', file, p, `"${k}" must be a positive integer`); else out[k] = v;
    } else if (k === 'aspect') {
      if (typeof v !== 'string' || !/^[1-9]\d*:[1-9]\d*$/.test(v)) d.error('invalid-value', file, p, '"aspect" must look like "1:1" or "16:9"'); else out[k] = v;
    } else if (k === 'formats') {
      const list = (Array.isArray(v) ? v : [v]).map((f) => (typeof f === 'string' ? EXT_FORMAT[f.toLowerCase()] : undefined));
      if (!list.length || list.some((f) => !f)) d.error('invalid-value', file, p, `"formats" must be a list of: ${FORMATS.join(', ')}`); else out[k] = [...new Set(list)];
    } else if (k === 'alpha') {
      if (!['required', 'forbidden', 'any'].includes(v)) d.error('invalid-value', file, p, '"alpha" must be "required", "forbidden" or "any"'); else out[k] = v;
    } else if (k === 'strict') {
      if (typeof v !== 'boolean') d.error('invalid-value', file, p, '"strict" must be true or false'); else out[k] = v;
    }
  }
  for (const [lo, hi] of [['minWidth', 'maxWidth'], ['minHeight', 'maxHeight']])
    if (out[lo] && out[hi] && out[lo] > out[hi]) d.error('invalid-value', file, ptr, `"${lo}" is greater than "${hi}"`);
  // A spec with an invalid value must not load half-applied (that would silently drop a constraint).
  return d.list.slice(errorsBefore).some((x) => x.level === 'error') ? null : out;
}

function cleanTargets(obj, file, ptr, d) {
  if (obj.target !== undefined && obj.targets !== undefined) { d.error('invalid-value', file, ptr, 'use either "target" or "targets", not both'); return undefined; }
  const raw = obj.target !== undefined ? [obj.target] : obj.targets;
  const key = obj.target !== undefined ? 'target' : 'targets';
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length) { d.error('invalid-type', file, ptrJoin(ptr, key), `"${key}" must be a${key === 'target' ? ' path string' : ' non-empty list'}`); return undefined; }
  const out = [];
  raw.forEach((t, i) => {
    const p = key === 'target' ? ptrJoin(ptr, key) : ptrJoin(ptrJoin(ptr, key), i);
    if (typeof t === 'string' && t.trim()) out.push({ path: t.trim() });
    else if (isObj(t) && typeof t.path === 'string' && t.path.trim()) {
      checkKeys(t, ['path', 'label'], file, p, d);
      out.push({ path: t.path.trim(), ...(typeof t.label === 'string' ? { label: t.label } : {}) });
    } else d.error('invalid-type', file, p, 'a target must be a path string or {path, label}');
  });
  return out;
}

const isStr = (v) => typeof v === 'string';
/** Validates the fields of a defaults/folder.defaults/sprite object and returns the cleaned "layer". */
function cleanLayer(obj, kind, file, ptr, d) {
  const layer = {};
  const bad = [];
  if (obj.spec !== undefined) { const s = cleanSpec(obj.spec, file, ptrJoin(ptr, 'spec'), d); if (s) layer.spec = s; else bad.push('spec'); }
  const t = cleanTargets(obj, file, ptr, d);
  if (t) layer.targets = t; else if (obj.target !== undefined || obj.targets !== undefined) bad.push('targets');
  if (obj.required !== undefined) { if (typeof obj.required === 'boolean') layer.required = obj.required; else { d.error('invalid-type', file, ptrJoin(ptr, 'required'), '"required" must be true or false'); bad.push('required'); } }
  if (obj.tags !== undefined) { if (Array.isArray(obj.tags) && obj.tags.every(isStr)) layer.tags = obj.tags; else { d.error('invalid-type', file, ptrJoin(ptr, 'tags'), '"tags" must be a list of strings'); bad.push('tags'); } }
  for (const k of ['notes', 'title', 'description', 'reference']) {
    if (obj[k] === undefined || (k !== 'notes' && kind === 'defaults')) continue;
    if (isStr(obj[k])) layer[k] = obj[k].trim(); else { d.error('invalid-type', file, ptrJoin(ptr, k), `"${k}" must be a string`); bad.push(k); }
  }
  return { layer, bad };
}

function mergeLayers(...layers) {
  const out = {};
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) out[k] = k === 'spec' ? { ...(out.spec ?? {}), ...v } : v;
  }
  return out;
}

/* ---------- matrix + placeholders ---------- */
function expandRange(v) {
  const m = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(v);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  if (a > b || b - a > MAX_COMBOS) return null;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function matrixCombos(matrix, file, ptr, d) {
  if (matrix === undefined) return [{}];
  if (!isObj(matrix) || !Object.keys(matrix).length) { d.error('invalid-type', file, ptr, '"matrix" must be a mapping of variable -> values'); return null; }
  const dims = [];
  for (const [name, vals] of Object.entries(matrix)) {
    const p = ptrJoin(ptr, name);
    if (!VAR_RE.test(name) || RESERVED_VARS.includes(name)) { d.error('invalid-matrix', file, p, `matrix variable "${name}" must match [a-z][a-z0-9_]* and not be one of ${RESERVED_VARS.join(', ')}`); return null; }
    let list = typeof vals === 'string' ? expandRange(vals) : vals;
    if (!Array.isArray(list) || !list.length || !list.every((x) => (typeof x === 'string' && x !== '') || typeof x === 'number')) {
      d.error('invalid-matrix', file, p, `values of "${name}" must be a non-empty list of strings/numbers or an integer range like "0..5"`); return null;
    }
    if (new Set(list.map(String)).size !== list.length) { d.error('invalid-matrix', file, p, `values of "${name}" contain duplicates`); return null; }
    dims.push([name, list]);
  }
  const total = dims.reduce((n, [, l]) => n * l.length, 1);
  if (total > MAX_COMBOS) { d.error('invalid-matrix', file, ptr, `matrix expands to ${total} sprites, the maximum is ${MAX_COMBOS}`); return null; }
  let combos = [{}];
  for (const [name, list] of dims) combos = combos.flatMap((c) => list.map((v) => ({ ...c, [name]: v })));
  return combos;
}

function subst(str, vars, file, ptr, d) {
  return str.replace(/\{\{|\}\}|\{([a-z][a-z0-9_]*)(?::0(\d+))?\}/g, (m, name, pad) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    if (!(name in vars)) { d.error('unknown-placeholder', file, ptr, `placeholder {${name}} is not defined here (available: ${Object.keys(vars).map((v) => `{${v}}`).join(', ') || 'none'})`); return m; }
    const v = String(vars[name]);
    return pad && /^-?\d+$/.test(v) ? v.padStart(+pad, '0') : v;
  });
}

const humanize = (s) => s.replace(/[-_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/* ---------- main ---------- */
export function loadContract(input) {
  const d = new Diags();
  const manifest = findManifest(input);
  const result = { manifest, root: null, project: null, folders: [], sprites: [], files: [], diagnostics: d.list, ok: false, fatal: null };
  if (!manifest) {
    result.fatal = `No contract found at "${input}". Expected a file or a directory containing one of: ${MANIFEST_NAMES.join(', ')}`;
    d.error('manifest-missing', String(input), '', result.fatal);
    return result;
  }

  const manifestDir = path.dirname(manifest);
  const folderDefs = new Map(); // id -> {id,title,description,icon,layer}
  const rawSprites = [];
  const visited = new Set();
  let rootLayer = {};

  const processFile = (file, isRoot, depth) => {
    if (visited.has(file)) { d.error('include-cycle', file, '', 'file is included more than once (cycle or duplicate include)'); return; }
    visited.add(file);
    result.files.push(file);
    const doc = readDoc(file, d);
    if (!doc) { if (isRoot) result.fatal = d.list.at(-1).message; return; }
    checkKeys(doc, isRoot ? KEYS.root : KEYS.included, file, '', d);
    if (!isRoot && doc.project !== undefined) d.warn('ignored-project', file, '/project', '"project" is only read from the root manifest and is ignored here');

    const ver = String(doc.contract ?? '');
    if (!ver) d.error('missing-version', file, '/contract', `"contract" is required, use contract: "${SPEC_VERSION}"`);
    else if (ver.split('.')[0] !== SPEC_VERSION.split('.')[0]) d.error('unsupported-version', file, '/contract', `contract version "${ver}" is not supported (this tool reads ${SPEC_VERSION})`);

    if (isRoot) {
      const p = doc.project;
      if (!isObj(p) || !isStr(p.name) || !p.name.trim()) d.error('missing-project', file, '/project/name', '"project.name" is required in the root manifest');
      if (isObj(p)) checkKeys(p, KEYS.project, file, '/project', d);
      const rootRel = isObj(p) && isStr(p.root) ? p.root : '.';
      result.root = path.resolve(manifestDir, rootRel);
      result.project = {
        name: isObj(p) && isStr(p.name) && p.name.trim() ? p.name.trim() : path.basename(manifestDir),
        description: isObj(p) && isStr(p.description) ? p.description : '',
        backups: !(isObj(p) && p.backups === false),
      };
      if (doc.defaults !== undefined) {
        if (!isObj(doc.defaults)) d.error('invalid-type', file, '/defaults', '"defaults" must be a mapping');
        else { checkKeys(doc.defaults, KEYS.defaults, file, '/defaults', d); rootLayer = cleanLayer(doc.defaults, 'defaults', file, '/defaults', d).layer; }
      }
    }

    let fileLayer = {};
    if (!isRoot && doc.defaults !== undefined) {
      if (!isObj(doc.defaults)) d.error('invalid-type', file, '/defaults', '"defaults" must be a mapping');
      else { checkKeys(doc.defaults, KEYS.defaults, file, '/defaults', d); fileLayer = cleanLayer(doc.defaults, 'defaults', file, '/defaults', d).layer; }
    }

    if (doc.folders !== undefined) {
      if (!isObj(doc.folders)) d.error('invalid-type', file, '/folders', '"folders" must be a mapping of folder path -> {title, description, icon, defaults}');
      else for (const [fid, f] of Object.entries(doc.folders)) {
        const p = ptrJoin('/folders', fid);
        if (!ID_RE.test(fid)) { d.error('invalid-id', file, p, `folder path "${fid}" is invalid (use segments of letters, digits, _ . - separated by "/")`); continue; }
        if (!isObj(f)) { d.error('invalid-type', file, p, 'a folder must be a mapping'); continue; }
        checkKeys(f, KEYS.folder, file, p, d);
        if (folderDefs.has(fid)) { d.error('duplicate-folder', file, p, `folder "${fid}" is already defined in ${path.relative(manifestDir, folderDefs.get(fid).file)}`); continue; }
        let layer = {};
        if (f.defaults !== undefined) {
          if (!isObj(f.defaults)) d.error('invalid-type', file, ptrJoin(p, 'defaults'), '"defaults" must be a mapping');
          else { checkKeys(f.defaults, KEYS.defaults, file, ptrJoin(p, 'defaults'), d); layer = cleanLayer(f.defaults, 'defaults', file, ptrJoin(p, 'defaults'), d).layer; }
        }
        for (const k of ['title', 'description', 'icon']) if (f[k] !== undefined && !isStr(f[k])) d.error('invalid-type', file, ptrJoin(p, k), `"${k}" must be a string`);
        folderDefs.set(fid, { id: fid, title: isStr(f.title) ? f.title : humanize(fid.split('/').pop()), description: isStr(f.description) ? f.description : '', icon: isStr(f.icon) ? f.icon : '', layer, file });
      }
    }

    if (doc.sprites !== undefined) {
      if (!Array.isArray(doc.sprites)) d.error('invalid-type', file, '/sprites', '"sprites" must be a list');
      else doc.sprites.forEach((s, i) => rawSprites.push({ s, file, ptr: `/sprites/${i}`, fileLayer }));
    }

    if (doc.include !== undefined) {
      const list = isStr(doc.include) ? [doc.include] : doc.include;
      if (!Array.isArray(list) || !list.every(isStr)) { d.error('invalid-type', file, '/include', '"include" must be a path/glob or a list of them'); return; }
      if (depth >= 8) { d.error('include-depth', file, '/include', 'includes are nested too deeply (max 8)'); return; }
      list.forEach((pat, i) => {
        const p = `/include/${i}`;
        if (path.isAbsolute(pat)) { d.error('invalid-include', file, p, 'include paths must be relative'); return; }
        const dir = path.dirname(file);
        if (!hasGlob(pat)) {
          const full = path.resolve(dir, pat);
          if (!fs.existsSync(full)) d.error('include-missing', file, p, `included file "${pat}" does not exist`);
          else processFile(full, false, depth + 1);
        } else {
          const matches = expandGlob(dir, pat).filter((f) => f !== file && !visited.has(f));
          if (!matches.length) d.warn('include-empty', file, p, `include pattern "${pat}" matched no files`);
          for (const m of matches) processFile(m, false, depth + 1);
        }
      });
    }
  };

  processFile(manifest, true, 0);
  if (result.fatal || !result.root) { result.ok = false; return result; }

  // Pass 2: finalize sprites (needs every folder + the root layer).
  const ids = new Map();
  const targetOwners = new Map();
  for (const { s, file, ptr, fileLayer } of rawSprites) {
    if (!isObj(s)) { d.error('invalid-type', file, ptr, 'a sprite must be a mapping'); continue; }
    checkKeys(s, KEYS.sprite, file, ptr, d);
    if (!isStr(s.id) || !s.id) { d.error('invalid-id', file, ptrJoin(ptr, 'id'), '"id" is required'); continue; }
    if (!isStr(s.description) || !s.description.trim()) { d.error('missing-description', file, ptrJoin(ptr, 'description'), `sprite "${s.id}" needs a non-empty "description" that says what the image shows`); continue; }
    const { layer: spriteLayer, bad } = cleanLayer(s, 'sprite', file, ptr, d);
    if (bad.length) continue;
    const combos = matrixCombos(s.matrix, file, ptrJoin(ptr, 'matrix'), d);
    if (!combos) continue;

    for (const vars of combos) {
      const idPtr = ptrJoin(ptr, 'id');
      const nDiag = d.list.length;
      const id = subst(s.id, vars, file, idPtr, d);
      if (d.list.length > nDiag) break; // unknown placeholder in id: same for every combination
      if (!ID_RE.test(id)) { d.error('invalid-id', file, idPtr, `id "${id}" is invalid (segments of letters, digits, _ . - separated by "/")`); continue; }
      if (ids.has(id)) { d.error('duplicate-id', file, idPtr, `id "${id}" is already used in ${path.relative(manifestDir, ids.get(id))}`); continue; }
      ids.set(id, file);

      const segs = id.split('/');
      const name = segs.at(-1);
      const folder = segs.slice(0, -1).join('/');
      const chain = segs.slice(0, -1).map((_, i) => folderDefs.get(segs.slice(0, i + 1).join('/'))?.layer);
      const eff = mergeLayers(rootLayer, fileLayer, ...chain, spriteLayer);
      const allVars = { ...vars, id, name, folder };

      const bpath = ptr;
      const sub = (v, key) => subst(v, allVars, file, ptrJoin(bpath, key), d);
      const before = d.list.length;
      const title = sub(eff.title ?? humanize(name), 'title');
      const description = sub(eff.description, 'description');
      const notes = eff.notes ? sub(eff.notes, 'notes') : '';
      const reference = eff.reference ? sub(eff.reference, 'reference') : '';
      const tags = (eff.tags ?? []).map((t) => sub(t, 'tags'));

      if (!eff.targets?.length) { d.error('no-targets', file, ptr, `sprite "${id}" has no "target(s)" and none are inherited from defaults`); ids.delete(id); continue; }
      const targets = [];
      let failed = d.list.length > before;
      eff.targets.forEach((t, ti) => {
        const tp = ptrJoin(ptrJoin(ptr, 'targets'), ti);
        const rel = subst(t.path, allVars, file, tp, d);
        const label = t.label ? subst(t.label, allVars, file, tp, d) : undefined;
        const norm = path.posix.normalize(rel.replace(/^\.\//, ''));
        if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || norm === '..' || norm.startsWith('../') || norm === '.') {
          d.error('target-escape', file, tp, `target "${rel}" must be a relative path inside the project root (no "..", no absolute paths, forward slashes only)`); failed = true; return;
        }
        const format = EXT_FORMAT[(path.posix.extname(norm).slice(1) || '').toLowerCase()];
        if (!format) { d.error('target-extension', file, tp, `target "${rel}" must end in one of: ${FORMATS.join(', ')}`); failed = true; return; }
        if (targets.some((x) => x.path === norm)) { d.error('duplicate-target', file, tp, `target "${norm}" is listed twice for "${id}"`); failed = true; return; }
        const owner = targetOwners.get(norm);
        if (owner) { d.error('target-conflict', file, tp, `target "${norm}" is already claimed by sprite "${owner}"`); failed = true; return; }
        targets.push({ path: norm, abs: path.resolve(result.root, norm), format, ...(label ? { label } : {}) });
      });
      if (failed || d.list.length > before) { ids.delete(id); continue; }
      for (const t of targets) targetOwners.set(t.path, id);

      const spec = { ...(eff.spec ?? {}) };
      const tFormats = [...new Set(targets.map((t) => t.format))];
      if (spec.formats) {
        const missing = tFormats.filter((f) => !spec.formats.includes(f));
        if (missing.length) { d.error('target-format-mismatch', file, ptrJoin(ptr, 'spec'), `"${id}" has target(s) in ${missing.join(', ')} but spec.formats only allows ${spec.formats.join(', ')}`); for (const t of targets) targetOwners.delete(t.path); ids.delete(id); continue; }
      } else spec.formats = tFormats;
      spec.alpha ??= 'any';
      spec.strict ??= true;

      result.sprites.push({ id, folder, name, title, description, required: eff.required ?? true, tags, notes, reference, spec, targets, source: path.relative(manifestDir, file).split(path.sep).join('/'), matrix: s.matrix !== undefined ? vars : undefined });
    }
  }

  // Folder list: declared folders first, then every ancestor path of a sprite, in order of appearance.
  const seen = new Map();
  const touch = (fid) => { if (fid.includes('/')) touch(fid.slice(0, fid.lastIndexOf('/'))); if (!seen.has(fid)) { const f = folderDefs.get(fid); seen.set(fid, { id: fid, title: f?.title ?? humanize(fid.split('/').pop()), description: f?.description ?? '', icon: f?.icon ?? '', declared: !!f, depth: fid.split('/').length }); } };
  const hasSprites = new Set(result.sprites.flatMap((sp) => { const g = sp.folder ? sp.folder.split('/') : []; return g.map((_, i) => g.slice(0, i + 1).join('/')); }));
  for (const fid of folderDefs.keys()) if (hasSprites.has(fid)) touch(fid); // declaration order wins
  for (const sp of result.sprites) { const segs = sp.folder ? sp.folder.split('/') : []; segs.forEach((_, i) => touch(segs.slice(0, i + 1).join('/'))); }
  for (const fid of folderDefs.keys()) if (!seen.has(fid)) { d.warn('empty-folder', folderDefs.get(fid).file, ptrJoin('/folders', fid), `folder "${fid}" has no sprites`); touch(fid); }
  const all = [...seen.values()];
  const parentOf = (id) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
  const ordered = [];
  const walk = (parent) => all.filter((f) => parentOf(f.id) === parent).forEach((f) => { ordered.push(f); walk(f.id); });
  walk('');
  result.folders = ordered; // tree order: every folder is followed by its children
  result.ok = !d.list.some((x) => x.level === 'error');
  return result;
}
