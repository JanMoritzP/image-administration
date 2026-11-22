// "Fit to frame" editor: lets a person scale and move an image so it exactly fills the size a sprite requires.
// Runs fully in the browser (canvas); the result is uploaded through the normal, validating upload path.

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** The exact pixel frame a sprite needs, or null when its spec does not fix one. */
export function frameOf(spec) {
  let { width: w, height: h } = spec;
  if (spec.aspect && (w == null) !== (h == null)) {
    const [aw, ah] = spec.aspect.split(':').map(Number);
    if (aw > 0 && ah > 0) {
      if (h == null) { const v = (w * ah) / aw; if (Number.isInteger(v)) h = v; }
      else { const v = (h * aw) / ah; if (Number.isInteger(v)) w = v; }
    }
  }
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Format the editor can write for this sprite (all targets must share it), or null (e.g. SVG/GIF targets). */
export function outputFormat(sprite) {
  const byExt = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif', svg: 'svg' };
  const fmts = [...new Set(sprite.targets.map((t) => byExt[t.path.split('.').pop().toLowerCase()]))];
  return fmts.length === 1 && MIME[fmts[0]] ? fmts[0] : null;
}

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cannot read this image')); };
    img.src = url;
  });
}

/**
 * Opens the editor. Resolves with a File of exactly frame size in the target format, or null when cancelled.
 * @param {{file: File, img: HTMLImageElement, frame: {w:number,h:number}, format: string, opaque: boolean, title: string}} o
 */
export function openFitEditor({ file, img, frame, format, opaque, title }) {
  return new Promise((resolve) => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const needsBg = opaque || format === 'jpeg';
    const view = Math.min(560 / frame.w, 360 / frame.h); // preview pixels per frame pixel
    const m = { scale: 1, ox: 0, oy: 0, smooth: Math.max(frame.w, frame.h) > 128, bg: '#ffffff', stretch: false };

    const root = document.createElement('div');
    root.className = 'fit-overlay';
    root.innerHTML = `
      <div class="fit" role="dialog" aria-modal="true" aria-label="Fit image to frame">
        <h2>Fit to frame <small>${frame.w}×${frame.h}px · ${format.toUpperCase()}</small></h2>
        <p class="fit-sub"></p>
        <div class="fit-stage"><canvas></canvas></div>
        <div class="fit-row">
          <button class="btn" data-m="contain" title="Whole image visible, may leave empty borders">Fit inside</button>
          <button class="btn" data-m="cover" title="Frame completely filled, edges are cropped">Fill frame</button>
          <button class="btn" data-m="stretch" title="Distorts the image to the frame">Stretch</button>
          <button class="btn" data-m="one" title="Original pixel size, centered">1:1</button>
          <label class="fit-zoom">Zoom <input type="range" min="0" max="1000" step="1" aria-label="Zoom"><output></output></label>
        </div>
        <div class="fit-row">
          <label><input type="checkbox" data-smooth> Smooth scaling <em>(off = crisp pixels)</em></label>
          ${needsBg ? '<label>Background <input type="color" data-bg value="#ffffff"></label>' : ''}
          <span class="fit-hint">Drag to move · mouse wheel to zoom · arrow keys nudge</span>
        </div>
        <div class="fit-row fit-end">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn primary" data-apply>Use this crop &amp; upload</button>
        </div>
      </div>`;
    document.body.append(root);

    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = Math.round(frame.w * view); canvas.height = Math.round(frame.h * view);
    const zoom = root.querySelector('input[type=range]');
    const zoomOut = root.querySelector('output');
    const smooth = root.querySelector('[data-smooth]');
    smooth.checked = m.smooth;
    root.querySelector('.fit-sub').textContent = `${file.name} · source ${iw}×${ih}px`;

    const sx = () => (m.stretch ? frame.w / iw : m.scale), sy = () => (m.stretch ? frame.h / ih : m.scale);
    const minScale = Math.min(frame.w / iw, frame.h / ih) / 4, maxScale = Math.max(frame.w / iw, frame.h / ih) * 8;
    const toSlider = (s) => Math.round((1000 * Math.log(s / minScale)) / Math.log(maxScale / minScale));
    const fromSlider = (v) => minScale * (maxScale / minScale) ** (v / 1000);

    function paint(c, k) { // k = canvas pixels per frame pixel
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, c.canvas.width, c.canvas.height);
      if (needsBg) { c.fillStyle = m.bg; c.fillRect(0, 0, c.canvas.width, c.canvas.height); }
      c.imageSmoothingEnabled = m.smooth; c.imageSmoothingQuality = 'high';
      c.setTransform(k, 0, 0, k, 0, 0);
      c.drawImage(img, m.ox, m.oy, iw * sx(), ih * sy());
    }
    function draw() {
      paint(ctx, view);
      zoom.value = toSlider(m.stretch ? Math.max(frame.w / iw, frame.h / ih) : m.scale);
      zoomOut.textContent = m.stretch ? 'stretched' : `${Math.round(m.scale * 100)}%`;
    }
    function place(mode) {
      m.stretch = mode === 'stretch';
      if (mode === 'stretch') { m.ox = 0; m.oy = 0; }
      else {
        m.scale = mode === 'one' ? 1 : (mode === 'cover' ? Math.max : Math.min)(frame.w / iw, frame.h / ih);
        m.ox = (frame.w - iw * m.scale) / 2; m.oy = (frame.h - ih * m.scale) / 2;
      }
      draw();
    }
    function zoomAt(newScale, cx = frame.w / 2, cy = frame.h / 2) { // keep the point under (cx,cy) fixed
      if (m.stretch) { m.stretch = false; m.scale = Math.max(frame.w / iw, frame.h / ih); }
      const s = Math.min(maxScale, Math.max(minScale, newScale));
      m.ox = cx - ((cx - m.ox) * s) / m.scale; m.oy = cy - ((cy - m.oy) * s) / m.scale; m.scale = s;
      draw();
    }
    const framePoint = (e) => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * frame.w, ((e.clientY - r.top) / r.height) * frame.h]; };

    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); const [x, y] = framePoint(e); drag = { x, y, ox: m.ox, oy: m.oy }; });
    canvas.addEventListener('pointermove', (e) => { if (!drag) return; const [x, y] = framePoint(e); m.ox = drag.ox + (x - drag.x); m.oy = drag.oy + (y - drag.y); draw(); });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = framePoint(e); zoomAt((m.stretch ? Math.max(frame.w / iw, frame.h / ih) : m.scale) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), x, y); }, { passive: false });
    zoom.addEventListener('input', () => zoomAt(fromSlider(Number(zoom.value))));
    smooth.addEventListener('change', () => { m.smooth = smooth.checked; draw(); });
    root.querySelector('[data-bg]')?.addEventListener('input', (e) => { m.bg = e.target.value; draw(); });
    root.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => place(b.dataset.m)));

    const close = (result) => { document.removeEventListener('keydown', onKey, true); root.remove(); resolve(result); };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      const step = e.shiftKey ? 10 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d && e.target.tagName !== 'INPUT') { e.preventDefault(); m.ox += d[0]; m.oy += d[1]; draw(); }
    }
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close(null); });
    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.querySelector('[data-apply]').addEventListener('click', () => {
      const out = document.createElement('canvas');
      out.width = frame.w; out.height = frame.h;
      paint(out.getContext('2d'), 1);
      out.toBlob((blob) => {
        if (!blob || blob.type !== MIME[format]) { alert(`This browser cannot write ${format.toUpperCase()} files.`); return; }
        const name = file.name.replace(/\.[^.]+$/, '') + '.' + EXT[format];
        close(new File([blob], name, { type: blob.type }));
      }, MIME[format], 0.92);
    });

    place(iw * ih && Math.abs(iw / ih - frame.w / frame.h) < 0.01 ? 'cover' : 'contain');
    root.querySelector('[data-apply]').focus();
  });
}
