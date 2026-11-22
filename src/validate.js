// Validates what a plugin sends to POST /api/requests and normalizes it. Never throws; returns errors/warnings as text.
import path from 'node:path';
import { FORMATS, EXT_FORMAT } from './formats.js';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;
const SPRITE_KEYS = ['id', 'title', 'description', 'required', 'tags', 'notes', 'spec', 'target', 'targets'];
const SPEC_KEYS = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'aspect', 'multipleOf', 'formats', 'alpha', 'maxBytes', 'strict'];
const INT_KEYS = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'multipleOf', 'maxBytes'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const humanize = (s) => s.replace(/[-_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

class Diags {
  errors = []; warnings = [];
  err(ptr, msg) { this.errors.push(`${ptr || '/'}: ${msg}`); }
  warn(ptr, msg) { this.warnings.push(`${ptr || '/'}: ${msg}`); }
  unknownKeys(obj, allowed, ptr) { for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.warn(`${ptr}/${k}`, `unknown key "${k}" is ignored`); }
}

function cleanSpec(spec, ptr, d) {
  if (!isObj(spec)) { d.err(ptr, '"spec" must be an object'); return null; }
  d.unknownKeys(spec, SPEC_KEYS, ptr);
  const out = {}; const before = d.errors.length;
  for (const [k, v] of Object.entries(spec)) {
    const p = `${ptr}/${k}`;
    if (INT_KEYS.includes(k)) { if (isPosInt(v)) out[k] = v; else d.err(p, `"${k}" must be a positive integer`); }
    else if (k === 'aspect') { if (isStr(v) && /^[1-9]\d*:[1-9]\d*$/.test(v)) out[k] = v; else d.err(p, '"aspect" must look like "1:1" or "16:9"'); }
    else if (k === 'formats') {
      const list = (Array.isArray(v) ? v : [v]).map((f) => (isStr(f) ? EXT_FORMAT[f.toLowerCase()] : undefined));
      if (!list.length || list.some((f) => !f)) d.err(p, `"formats" must be a list of: ${FORMATS.join(', ')}`); else out[k] = [...new Set(list)];
    }
    else if (k === 'alpha') { if (['required', 'forbidden', 'any'].includes(v)) out[k] = v; else d.err(p, '"alpha" must be "required", "forbidden" or "any"'); }
    else if (k === 'strict') { if (typeof v === 'boolean') out[k] = v; else d.err(p, '"strict" must be true or false'); }
  }
  for (const [lo, hi] of [['minWidth', 'maxWidth'], ['minHeight', 'maxHeight']]) if (out[lo] && out[hi] && out[lo] > out[hi]) d.err(ptr, `"${lo}" is greater than "${hi}"`);
  return d.errors.length > before ? null : out;
}

function cleanTargets(s, ptr, d) {
  if (s.target !== undefined && s.targets !== undefined) { d.err(ptr, 'use either "target" or "targets", not both'); return null; }
  const key = s.target !== undefined ? 'target' : 'targets';
  const raw = s.target !== undefined ? [s.target] : s.targets;
  if (raw === undefined) { d.err(ptr, 'needs a "target" (path string) or "targets" (list)'); return null; }
  if (!Array.isArray(raw) || !raw.length) { d.err(`${ptr}/${key}`, '"targets" must be a non-empty list'); return null; }
  const out = [];
  raw.forEach((t, i) => {
    const p = key === 'target' ? `${ptr}/target` : `${ptr}/targets/${i}`;
    const entry = isStr(t) ? { path: t } : isObj(t) && isStr(t.path) ? t : null;
    if (!entry || !entry.path.trim()) { d.err(p, 'a target must be a path string or {path, label}'); return; }
    const rel = entry.path.trim();
    const norm = path.posix.normalize(rel.replace(/^\.\//, ''));
    if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || norm === '..' || norm.startsWith('../') || norm === '.' || norm.includes('//')) { d.err(p, `target "${rel}" must be a relative path (no "..", no leading "/", forward slashes only)`); return; }
    const format = EXT_FORMAT[path.posix.extname(norm).slice(1).toLowerCase()];
    if (!format) { d.err(p, `target "${rel}" must end in one of: ${FORMATS.join(', ')}`); return; }
    if (out.some((x) => x.path === norm)) { d.err(p, `target "${norm}" is listed twice`); return; }
    out.push({ path: norm, format, ...(isStr(entry.label) && entry.label ? { label: entry.label } : {}) });
  });
  return out.length === raw.length ? out : null;
}

/** @returns {{errors: string[], warnings: string[], project: object|null, folders: object[], sprites: object[]}} */
export function validateRequest(payload) {
  const d = new Diags();
  const res = { errors: d.errors, warnings: d.warnings, project: null, folders: [], sprites: [] };
  if (!isObj(payload)) { d.err('', 'body must be a JSON object: {"project": {...}, "folders": {...}, "sprites": [...]}'); return res; }
  d.unknownKeys(payload, ['project', 'folders', 'sprites'], '');
  if (payload.project === undefined && payload.folders === undefined && payload.sprites === undefined) { d.err('', 'nothing to add: send "project", "folders" and/or "sprites"'); return res; }

  if (payload.project !== undefined) {
    const p = payload.project;
    if (!isObj(p)) d.err('/project', '"project" must be an object');
    else {
      d.unknownKeys(p, ['name', 'description'], '/project');
      if (p.name !== undefined && (!isStr(p.name) || !p.name.trim())) d.err('/project/name', '"name" must be a non-empty string');
      if (p.description !== undefined && !isStr(p.description)) d.err('/project/description', '"description" must be a string');
      res.project = { ...(isStr(p.name) ? { name: p.name.trim() } : {}), ...(isStr(p.description) ? { description: p.description } : {}) };
    }
  }

  if (payload.folders !== undefined) {
    if (!isObj(payload.folders)) d.err('/folders', '"folders" must be an object: folder path -> {title, description, icon}');
    else for (const [id, f] of Object.entries(payload.folders)) {
      const p = `/folders/${id}`;
      if (!ID_RE.test(id)) { d.err(p, `folder path "${id}" is invalid (segments of letters, digits, _ . - separated by "/")`); continue; }
      if (!isObj(f)) { d.err(p, 'a folder must be an object'); continue; }
      d.unknownKeys(f, ['title', 'description', 'icon'], p);
      if (['title', 'description', 'icon'].some((k) => f[k] !== undefined && !isStr(f[k]))) { d.err(p, 'title, description and icon must be strings'); continue; }
      res.folders.push({ id, title: f.title?.trim() || humanize(id.split('/').pop()), description: f.description ?? '', icon: f.icon ?? '' });
    }
  }

  if (payload.sprites !== undefined) {
    if (!Array.isArray(payload.sprites)) d.err('/sprites', '"sprites" must be a list');
    else {
      const seen = new Set();
      payload.sprites.forEach((s, i) => {
        const p = `/sprites/${i}`; const before = d.errors.length;
        if (!isObj(s)) { d.err(p, 'a sprite must be an object'); return; }
        d.unknownKeys(s, SPRITE_KEYS, p);
        if (!isStr(s.id) || !ID_RE.test(s.id)) { d.err(`${p}/id`, `"id" is required: segments of letters, digits, _ . - separated by "/" (got ${JSON.stringify(s.id)})`); return; }
        if (seen.has(s.id)) d.err(`${p}/id`, `id "${s.id}" appears twice in this request`);
        seen.add(s.id);
        if (!isStr(s.description) || !s.description.trim()) d.err(`${p}/description`, `sprite "${s.id}" needs a non-empty "description" that says what the image shows`);
        if (s.title !== undefined && !isStr(s.title)) d.err(`${p}/title`, '"title" must be a string');
        if (s.notes !== undefined && !isStr(s.notes)) d.err(`${p}/notes`, '"notes" must be a string');
        if (s.required !== undefined && typeof s.required !== 'boolean') d.err(`${p}/required`, '"required" must be true or false');
        if (s.tags !== undefined && !(Array.isArray(s.tags) && s.tags.every(isStr))) d.err(`${p}/tags`, '"tags" must be a list of strings');
        const spec = s.spec === undefined ? {} : cleanSpec(s.spec, `${p}/spec`, d);
        const targets = cleanTargets(s, p, d);
        if (d.errors.length > before || !spec || !targets) return;
        const tFormats = [...new Set(targets.map((t) => t.format))];
        if (spec.formats) {
          const missing = tFormats.filter((f) => !spec.formats.includes(f));
          if (missing.length) { d.err(`${p}/spec`, `"${s.id}" has target(s) in ${missing.join(', ')} but spec.formats only allows ${spec.formats.join(', ')}`); return; }
        } else spec.formats = tFormats;
        spec.alpha ??= 'any'; spec.strict ??= true;
        res.sprites.push({
          id: s.id, title: s.title?.trim() || humanize(s.id.split('/').pop()), description: s.description.trim(),
          required: s.required ?? true, tags: s.tags ?? [], notes: s.notes?.trim() ?? '', spec,
          targets: targets.map(({ path: tp, label }) => ({ path: tp, label })),
        });
      });
    }
  }
  return res;
}
