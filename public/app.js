const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API_HEADERS = { 'X-Sprite-Admin': '1' };

let state = null, folder = '', filter = 'all', query = '', pickFor = null, lastJson = '';
const busy = new Set();

/* ---------- data ---------- */
async function refresh(force) {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const text = await r.text();
    if (!force && text === lastJson) return;
    lastJson = text;
    state = JSON.parse(text);
    render();
  } catch { /* server stopped; keep last view */ }
}

async function upload(id, file) {
  busy.add(id); render();
  try {
    const r = await fetch(`/api/upload?id=${encodeURIComponent(id)}`, { method: 'POST', headers: { ...API_HEADERS, 'Content-Type': 'application/octet-stream' }, body: file });
    const j = await r.json();
    if (j.ok) toast(`Delivered <b>${esc(id)}</b> to ${j.sprite.targets.length} place${j.sprite.targets.length > 1 ? 's' : ''}`, j.warnings.length ? 'warn' : 'ok', j.warnings);
    else toast(`Rejected <b>${esc(file.name)}</b> for <b>${esc(id)}</b>`, 'bad', j.errors);
    return j.ok;
  } catch (e) { toast('Upload failed: ' + esc(e.message), 'bad'); }
  finally { busy.delete(id); await refresh(true); }
}

async function sync(id) {
  busy.add(id); render();
  try {
    const j = await (await fetch(`/api/sync?id=${encodeURIComponent(id)}`, { method: 'POST', headers: API_HEADERS })).json();
    toast(j.ok ? `Synced targets of <b>${esc(id)}</b>` : `Could not sync <b>${esc(id)}</b>`, j.ok ? 'ok' : 'bad', j.errors);
  } finally { busy.delete(id); await refresh(true); }
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
  const reqDone = s.requiredDone, reqTotal = s.requiredTotal;
  $('#overall').innerHTML = `
    <div class="nums"><b>${s.percent}% complete</b><span>${reqDone}/${reqTotal} required · ${s.done}/${s.total} total · ${s.missing} missing${s.partial + s.invalid ? ` · <b style="color:var(--warn)">${s.partial + s.invalid} need attention</b>` : ''}</span></div>
    ${barHtml(s.done, s.partial + s.invalid, s.total)}`;

  const diags = state.diagnostics ?? [];
  $('#banner').innerHTML = diags.length ? `<div class="banner ${diags.some((d) => d.level === 'error') ? 'err' : ''}">
    <h4>${state.fatal ? 'Contract could not be loaded' : 'Contract diagnostics'} (${diags.length})</h4>
    <ul>${diags.map((d) => `<li class="lv-${d.level}"><code>${esc(d.file.split('/').slice(-2).join('/'))}${esc(d.pointer)}</code> ${esc(d.message)}</li>`).join('')}</ul></div>` : '';

  // folder tree
  const total = state.summary;
  $('#tree').innerHTML = [{ id: '', title: 'All sprites', icon: '🗂️', depth: 0, ...total }, ...state.folders].map((f) => `
    <button class="f ${f.id === folder ? 'sel' : ''} ${f.done === f.total && f.total ? 'done' : ''}" data-folder="${esc(f.id)}" style="padding-left:${10 + Math.max(0, f.depth - 1) * 16}px">
      <span class="row"><span>${esc(f.icon ? f.icon + ' ' : '')}${esc(f.title)}</span><span class="cnt">${f.done}/${f.total}</span></span>
      ${barHtml(f.done, f.partial + f.invalid, f.total, true)}
    </button>`).join('');

  const cur = state.folders.find((f) => f.id === folder);
  $('#crumb').innerHTML = `<h2>${esc(cur ? cur.title : 'All sprites')}</h2><p>${esc(cur?.description ?? 'Every sprite the contract asks for. Pick a folder on the left to narrow down.')}</p>`;

  const counts = { all: 0, missing: 0, attention: 0, available: 0 };
  const inFolder = state.sprites.filter((sp) => !folder || sp.folder === folder || sp.folder.startsWith(folder + '/'));
  for (const sp of inFolder) { counts.all++; counts[sp.status === 'available' ? 'available' : sp.status === 'missing' ? 'missing' : 'attention']++; }
  $('#filters').innerHTML = [['all', 'All'], ['missing', 'Missing'], ['attention', 'Needs attention'], ['available', 'Available']].map(([k, l]) =>
    `<button class="chip" role="tab" aria-selected="${filter === k}" data-filter="${k}">${l} ${counts[k]}</button>`).join('');

  const q = query.trim().toLowerCase();
  const list = inFolder.filter((sp) => {
    if (filter === 'missing' && sp.status !== 'missing') return false;
    if (filter === 'available' && sp.status !== 'available') return false;
    if (filter === 'attention' && !['partial', 'invalid'].includes(sp.status)) return false;
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
  const present = sp.targets.find((t) => t.exists);
  const label = { available: 'Available', missing: 'Missing', partial: 'Partial', invalid: 'Invalid' }[sp.status];
  const thumb = present ? `<img loading="lazy" alt="" src="/api/image?id=${encodeURIComponent(sp.id)}&v=${sp.version}">`
    : `<div class="empty"><span style="font-size:26px">🖼️</span>${sp.spec.width && sp.spec.height ? `${sp.spec.width}×${sp.spec.height}` : 'no image yet'}</div>`;
  const targets = sp.targets.map((t) => {
    const bad = t.issues.some((i) => i.level === 'error');
    const cls = !t.exists ? 't-no' : bad ? 't-bad' : 't-ok';
    return `<li class="${cls}"><span class="m">${!t.exists ? '○' : bad ? '✕' : '✓'}</span><code>${esc(t.path)}</code>${t.label ? ` <em>${esc(t.label)}</em>` : ''}${t.exists && t.width ? ` <em>${t.width}×${t.height}</em>` : ''}</li>`;
  }).join('');
  const issues = sp.issues.filter((i) => i.code !== 'target-missing' || sp.status === 'partial');
  const isBusy = busy.has(sp.id);
  return `<article class="card s-${sp.status}" data-id="${esc(sp.id)}">
    <div class="thumb">${thumb}<span class="badge">${label}</span></div>
    <div class="body">
      <h3><span>${esc(sp.title)}</span>${sp.required ? '' : '<span class="opt">optional</span>'}</h3>
      <code class="id">${esc(sp.id)}</code>
      <p class="desc">${esc(sp.description)}</p>
      <div class="specs">${specChips(sp)}</div>
      <ul class="targets">${targets}</ul>
      ${issues.length ? `<ul class="issues">${issues.map((i) => `<li class="${i.level === 'warn' ? 'w' : ''}">${esc(i.message)}${sp.targets.length > 1 ? ` <code>${esc(i.target)}</code>` : ''}</li>`).join('')}</ul>` : ''}
      ${deliveryLine(sp)}
      ${sp.notes ? `<p class="notes">${esc(sp.notes)}</p>` : ''}
      ${sp.tags.length ? `<div class="tags">${sp.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="actions">
        <button class="btn primary" data-upload="${esc(sp.id)}" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Working…' : present ? 'Replace image' : 'Upload image'}</button>
        ${sp.status === 'partial' ? `<button class="btn" data-sync="${esc(sp.id)}" ${isBusy ? 'disabled' : ''}>Sync targets</button>` : ''}
      </div>
    </div></article>`;
}

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-folder],[data-filter],[data-upload],[data-sync]');
  if (!t) return;
  if (t.dataset.folder !== undefined) { folder = t.dataset.folder; render(); }
  else if (t.dataset.filter) { filter = t.dataset.filter; render(); }
  else if (t.dataset.upload) { pickFor = t.dataset.upload; $('#picker').value = ''; $('#picker').click(); }
  else if (t.dataset.sync) sync(t.dataset.sync);
});
$('#search').addEventListener('input', (e) => { query = e.target.value; render(); });
$('#picker').addEventListener('change', (e) => { const f = e.target.files[0]; if (f && pickFor) upload(pickFor, f); });

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
  if (card) { if (files[0]) await upload(card.dataset.id, files[0]); if (files.length > 1) toast('Only the first file was used; drop several files outside a card to auto-match them.', 'warn'); return; }
  await bulk(files);
});

const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
async function bulk(files) {
  let ok = 0; const problems = [];
  for (const f of files) {
    const s = stem(f.name);
    const hits = state.sprites.filter((sp) => [sp.name, sp.id, sp.id.replaceAll('/', '_'), sp.id.replaceAll('/', '-'), ...sp.targets.map((t) => stem(t.path.split('/').pop()))].some((c) => c.toLowerCase() === s));
    if (hits.length === 1) { if (await upload(hits[0].id, f)) ok++; }
    else problems.push(`${f.name}: ${hits.length ? `ambiguous (${hits.length} sprites match, drop it onto the right card)` : 'no sprite matches this file name'}`);
  }
  if (files.length > 1 || problems.length) toast(`${ok}/${files.length} files delivered`, problems.length ? 'warn' : 'ok', problems);
}

refresh(true);
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
window.addEventListener('focus', () => refresh());
