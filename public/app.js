import { frameOf, outputFormat, loadImage, openFitEditor } from './fit.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API_HEADERS = { 'X-Sprite-Admin': '1' };

let state = null, folder = '', filter = 'all', query = '', pickFor = null, lastJson = '';
// every project is its own set of sprites; the choice is remembered in this browser
let projectId = localStorage.getItem('project') || 'default', projects = [];
const inProject = (u) => `${u}${u.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`;
const busy = new Set();

/* ---------- data ---------- */
async function refresh(force) {
  try {
    const pr = await fetch('/api/projects', { cache: 'no-store' });
    if (pr.status === 401) { showLogin(); return; }
    hideLogin();
    projects = (await pr.json()).projects ?? [];
    // nothing chosen yet and the default project is empty: open the first project that has sprites
    if (!localStorage.getItem('project') && projectId === 'default' && !projects.find((p) => p.id === 'default')?.total) {
      const first = projects.find((p) => p.total);
      if (first) { projectId = first.id; force = true; }
    }
    if (!projects.some((p) => p.id === projectId)) { projectId = 'default'; folder = ''; force = true; } // the project was deleted
    const r = await fetch(inProject('/api/state'), { cache: 'no-store' });
    const stateText = await r.text();
    const text = stateText + JSON.stringify(projects.map((p) => [p.id, p.name, p.percent]));
    if (!force && text === lastJson) return;
    lastJson = text;
    state = JSON.parse(stateText);
    render();
  } catch { /* server stopped; keep last view */ }
}

async function upload(id, file) {
  busy.add(id); render();
  try {
    const r = await fetch(inProject(`/api/upload?id=${encodeURIComponent(id)}`), { method: 'POST', headers: { ...API_HEADERS, 'Content-Type': 'application/octet-stream' }, body: file });
    const j = await r.json();
    if (j.ok) toast(`Delivered <b>${esc(id)}</b> to ${j.sprite.targets.length} place${j.sprite.targets.length > 1 ? 's' : ''}`, j.warnings.length ? 'warn' : 'ok', j.warnings);
    else toast(`Rejected <b>${esc(file.name)}</b> for <b>${esc(id)}</b>`, 'bad', j.errors);
    return j.ok;
  } catch (e) { toast('Upload failed: ' + esc(e.message), 'bad'); }
  finally { busy.delete(id); await refresh(true); }
}

/** Upload through the fit editor when the image does not already have the exact size the sprite requires. */
async function startUpload(id, file) {
  const sp = state.sprites.find((x) => x.id === id);
  const frame = sp && frameOf(sp.spec), format = sp && outputFormat(sp);
  if (frame && format) {
    let loaded = null;
    try { loaded = await loadImage(file); } catch { /* let the server explain what is wrong with the file */ }
    if (loaded) {
      try {
        const { img } = loaded;
        if (img.naturalWidth !== frame.w || img.naturalHeight !== frame.h) {
          const fitted = await openFitEditor({ file, img, frame, format, opaque: sp.spec.alpha === 'forbidden', title: sp.title });
          if (!fitted) return false;
          file = fitted;
        }
      } finally { URL.revokeObjectURL(loaded.url); }
    }
  }
  return upload(id, file);
}

function toast(html, kind = 'ok', list = []) {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'ok' ? '' : kind}`;
  el.innerHTML = html + (list.length ? `<ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 12000 : 5000);
}

/* ---------- rendering ---------- */
function barHtml(done, attention, total, thin) {
  const p = (n) => (total ? (100 * n) / total : 0);
  return `<div class="bar${thin ? ' thin' : ''}"><i class="ok" style="width:${p(done)}%"></i><i class="warn" style="width:${p(attention)}%"></i></div>`;
}

function render() {
  if (!state) return;
  const s = state.summary;
  $('#projectName').textContent = state.project?.name ?? 'Image Administration';
  $('#projectDesc').textContent = state.project?.description ?? '';
  document.title = `${state.project?.name ?? 'Sprites'} · ${s.percent}%`;
  const sel = $('#projectSelect');
  sel.hidden = projects.length < 2;
  sel.innerHTML = projects.map((p) => `<option value="${esc(p.id)}"${p.id === projectId ? ' selected' : ''}>${esc(p.name)} · ${p.percent}%</option>`).join('');
  const reqDone = s.requiredDone, reqTotal = s.requiredTotal;
  $('#overall').innerHTML = `
    <div class="nums"><b>${s.percent}% complete</b><span>${reqDone}/${reqTotal} required · ${s.done}/${s.total} total · ${s.missing} missing${s.invalid ? ` · <b style="color:var(--warn)">${s.invalid} need attention</b>` : ''}</span></div>
    ${barHtml(s.done, s.invalid, s.total)}`;

  // folder tree
  const total = state.summary;
  $('#tree').innerHTML = [{ id: '', title: 'All sprites', icon: '🗂️', depth: 0, ...total }, ...state.folders].map((f) => `
    <button class="f ${f.id === folder ? 'sel' : ''} ${f.done === f.total && f.total ? 'done' : ''}" data-folder="${esc(f.id)}" style="padding-left:${10 + Math.max(0, f.depth - 1) * 16}px">
      <span class="row"><span>${esc(f.icon ? f.icon + ' ' : '')}${esc(f.title)}</span><span class="cnt">${f.done}/${f.total}</span></span>
      ${barHtml(f.done, f.invalid, f.total, true)}
    </button>`).join('');

  const cur = state.folders.find((f) => f.id === folder);
  $('#crumb').innerHTML = `<h2>${esc(cur ? cur.title : 'All sprites')}</h2><p>${esc(cur?.description ?? 'Every image that has been requested. Pick a folder on the left to narrow down.')}</p>`;

  const counts = { all: 0, missing: 0, attention: 0, available: 0 };
  const inFolder = state.sprites.filter((sp) => !folder || sp.folder === folder || sp.folder.startsWith(folder + '/'));
  for (const sp of inFolder) { counts.all++; counts[sp.status === 'available' ? 'available' : sp.status === 'missing' ? 'missing' : 'attention']++; }
  $('#filters').innerHTML = [['all', 'All'], ['missing', 'Missing'], ['attention', 'Needs attention'], ['available', 'Available']].map(([k, l]) =>
    `<button class="chip" role="tab" aria-selected="${filter === k}" data-filter="${k}">${l} ${counts[k]}</button>`).join('');

  const q = query.trim().toLowerCase();
  const list = inFolder.filter((sp) => {
    if (filter === 'missing' && sp.status !== 'missing') return false;
    if (filter === 'available' && sp.status !== 'available') return false;
    if (filter === 'attention' && sp.status !== 'invalid') return false;
    return !q || [sp.id, sp.title, sp.description, ...sp.tags].join(' ').toLowerCase().includes(q);
  });
  $('#grid').innerHTML = list.length ? list.map(card).join('') : '<div class="empty-state">Nothing here. 🎉 or adjust the filter.</div>';
}

function specChips(sp) {
  const s = sp.spec, out = [];
  if (s.width && s.height) out.push(`${s.width}×${s.height}px`);
  else {
    if (s.width) out.push(`width ${s.width}px`); if (s.height) out.push(`height ${s.height}px`);
    if (s.minWidth || s.maxWidth) out.push(`width ${s.minWidth ?? '…'}–${s.maxWidth ?? '…'}px`);
    if (s.minHeight || s.maxHeight) out.push(`height ${s.minHeight ?? '…'}–${s.maxHeight ?? '…'}px`);
  }
  if (s.aspect) out.push(`aspect ${s.aspect}`);
  if (s.multipleOf) out.push(`multiple of ${s.multipleOf}`);
  out.push(s.formats.map((f) => f.toUpperCase()).join(' / '));
  if (s.alpha === 'required') out.push('transparent');
  if (s.alpha === 'forbidden') out.push('opaque');
  if (s.maxBytes) out.push(`≤ ${(s.maxBytes / 1024).toFixed(s.maxBytes < 10240 ? 1 : 0)} KB`);
  if (s.strict === false) out.push('lenient');
  return out.map((x) => `<span>${esc(x)}</span>`).join('');
}

function deliveryLine(sp) {
  const d = state.delivery?.[sp.id];
  if (!d) return '';
  const txt = { delivered: '✓ pushed to plugin', pending: '… pushing to plugin', failed: `✕ push failed (${esc(d.error ?? 'error')})` }[d.status];
  return `<p class="notes">${txt}</p>`;
}

function card(sp) {
  const present = !!sp.image;
  const label = { available: 'Available', missing: 'Missing', invalid: 'Invalid' }[sp.status];
  const thumb = present ? `<img loading="lazy" alt="" src="${inProject(`/api/file?id=${encodeURIComponent(sp.id)}&v=${sp.version}`)}">`
    : `<div class="empty"><span style="font-size:26px">🖼️</span>${sp.spec.width && sp.spec.height ? `${sp.spec.width}×${sp.spec.height}` : 'no image yet'}</div>`;
  const targets = sp.targets.map((t) => `<li class="${!present ? 't-no' : sp.status === 'invalid' ? 't-bad' : 't-ok'}"><span class="m">${!present ? '○' : sp.status === 'invalid' ? '✕' : '✓'}</span><code>${esc(t.path)}</code>${t.label ? ` <em>${esc(t.label)}</em>` : ''}</li>`).join('');
  const isBusy = busy.has(sp.id);
  return `<article class="card s-${sp.status}" data-id="${esc(sp.id)}">
    <div class="thumb">${thumb}<span class="badge">${label}</span></div>
    <div class="body">
      <h3><span>${esc(sp.title)}</span>${sp.required ? '' : '<span class="opt">optional</span>'}</h3>
      <code class="id">${esc(sp.id)}</code>
      <p class="desc">${esc(sp.description)}</p>
      <div class="specs">${specChips(sp)}</div>
      <ul class="targets">${targets}</ul>
      ${present ? `<p class="notes">Stored: ${sp.image.width ? `${sp.image.width}×${sp.image.height}px · ` : ''}${sp.image.format.toUpperCase()} · ${(sp.image.bytes / 1024).toFixed(sp.image.bytes < 10240 ? 1 : 0)} KB</p>` : ''}
      ${sp.issues.length ? `<ul class="issues">${sp.issues.map((i) => `<li class="${i.level === 'warn' ? 'w' : ''}">${esc(i.message)}</li>`).join('')}</ul>` : ''}
      ${deliveryLine(sp)}
      ${sp.notes ? `<p class="notes">${esc(sp.notes)}</p>` : ''}
      ${sp.tags.length ? `<div class="tags">${sp.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="actions">
        <button class="btn primary" data-upload="${esc(sp.id)}" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Working…' : present ? 'Replace image' : 'Upload image'}</button>
      </div>
    </div></article>`;
}

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-folder],[data-filter],[data-upload],[data-logout]');
  if (!t) return;
  if (t.dataset.folder !== undefined) { folder = t.dataset.folder; render(); }
  else if (t.dataset.filter) { filter = t.dataset.filter; render(); }
  else if (t.dataset.upload) { pickFor = t.dataset.upload; $('#picker').value = ''; $('#picker').click(); }
  else if (t.dataset.logout !== undefined) logout();
});
$('#projectSelect').addEventListener('change', (e) => { projectId = e.target.value; localStorage.setItem('project', projectId); folder = ''; state = null; lastJson = ''; refresh(true); });
$('#search').addEventListener('input', (e) => { query = e.target.value; render(); });
$('#picker').addEventListener('change', (e) => { const f = e.target.files[0]; if (f && pickFor) startUpload(pickFor, f); });

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#veil').classList.add('on'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#veil').classList.remove('on'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); document.querySelectorAll('.card.drag').forEach((c) => c.classList.remove('drag')); e.target.closest?.('.card')?.classList.add('drag'); } });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#veil').classList.remove('on');
  document.querySelectorAll('.card.drag').forEach((c) => c.classList.remove('drag'));
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name));
  const card = e.target.closest?.('.card');
  if (card) { if (files[0]) await startUpload(card.dataset.id, files[0]); if (files.length > 1) toast('Only the first file was used; drop several files outside a card to auto-match them.', 'warn'); return; }
  await bulk(files);
});

const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
async function bulk(files) {
  let ok = 0; const problems = [];
  for (const f of files) {
    const s = stem(f.name);
    const hits = state.sprites.filter((sp) => [sp.name, sp.id, sp.id.replaceAll('/', '_'), sp.id.replaceAll('/', '-'), ...sp.targets.map((t) => stem(t.path.split('/').pop()))].some((c) => c.toLowerCase() === s));
    if (hits.length === 1) { if (await startUpload(hits[0].id, f)) ok++; }
    else problems.push(`${f.name}: ${hits.length ? `ambiguous (${hits.length} sprites match, drop it onto the right card)` : 'no sprite matches this file name'}`);
  }
  if (files.length > 1 || problems.length) toast(`${ok}/${files.length} files delivered`, problems.length ? 'warn' : 'ok', problems);
}

/* ---------- login ---------- */
function showLogin() { $('#login').classList.add('on'); $('#loginToken').focus(); }
function hideLogin() { $('#login').classList.remove('on'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: API_HEADERS, body: JSON.stringify({ token: $('#loginToken').value }) });
  $('#loginError').textContent = r.ok ? '' : r.status === 429 ? 'Too many attempts, wait a minute.' : 'Wrong token.';
  if (r.ok) { $('#loginToken').value = ''; await refresh(true); }
});
async function logout() { await fetch('/api/logout', { method: 'POST', headers: API_HEADERS }); state = null; lastJson = ''; showLogin(); }

refresh(true);
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
window.addEventListener('focus', () => refresh());
