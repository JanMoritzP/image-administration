// Dependency-free image inspection: detect format, read dimensions and alpha from file headers.
import { EXT_FORMAT } from './formats.js';

export function detectFormat(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 2048)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

function probePng(buf) {
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), colorType = buf[25];
  let alpha = colorType === 4 || colorType === 6;
  for (let i = 8; !alpha && i + 8 <= buf.length;) {
    const len = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return { width, height, alpha };
}

function probeJpeg(buf) {
  for (let i = 2; i + 4 <= buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), alpha: false };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function probeWebp(buf) {
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, alpha: false };
  if (kind === 'VP8L') {
    const b = buf.subarray(21, 25);
    return { width: 1 + (b[0] | ((b[1] & 0x3f) << 8)), height: 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)), alpha: !!((b[3] >> 4) & 1) };
  }
  if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), alpha: !!(buf[20] & 0x10) };
  return null;
}

function probeSvg(buf) {
  const text = buf.toString('utf8');
  const tag = (text.match(/<svg\b[^>]*>/i) || [''])[0];
  const num = (name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i'));
    return m ? Math.round(parseFloat(m[1])) : null;
  };
  let width = num('width'), height = num('height');
  if (width == null || height == null) {
    const vb = tag.match(/viewBox\s*=\s*["']\s*[-0-9.]+[ ,]+[-0-9.]+[ ,]+([0-9.]+)[ ,]+([0-9.]+)\s*["']/i);
    if (vb) { width ??= Math.round(parseFloat(vb[1])); height ??= Math.round(parseFloat(vb[2])); }
  }
  const unsafe = /<script[\s>]|\son[a-z]+\s*=|<foreignObject[\s>]/i.test(text);
  return { width, height, alpha: true, unsafe };
}

/** Returns {format,width,height,alpha,bytes,unsafe?} or null when the bytes are not a supported image. alpha=null means unknown. */
export function probeImage(buf) {
  const format = detectFormat(buf);
  if (!format) return null;
  try {
    let r = null;
    if (format === 'png') r = probePng(buf);
    else if (format === 'jpg') r = probeJpeg(buf);
    else if (format === 'webp') r = probeWebp(buf);
    else if (format === 'svg') r = probeSvg(buf);
    else if (format === 'gif') r = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), alpha: null };
    if (!r) return { format, width: null, height: null, alpha: null, bytes: buf.length };
    return { format, bytes: buf.length, ...r };
  } catch {
    return { format, width: null, height: null, alpha: null, bytes: buf.length };
  }
}

export function formatOfPath(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(p);
  return m ? EXT_FORMAT[m[1].toLowerCase()] ?? null : null;
}

/** Check probed image info against a normalized spec. Returns [{level,code,message}]. */
export function checkSpec(info, spec) {
  const level = spec.strict === false ? 'warn' : 'error';
  const out = [];
  const add = (code, message) => out.push({ level, code, message });
  if (spec.formats && !spec.formats.includes(info.format)) add('format', `format is ${info.format.toUpperCase()}, allowed: ${spec.formats.map((f) => f.toUpperCase()).join(', ')}`);
  const { width: w, height: h } = info;
  if (w == null || h == null) {
    if (['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'aspect', 'multipleOf'].some((k) => spec[k] != null))
      out.push({ level: 'warn', code: 'dimensions-unknown', message: 'image dimensions could not be read, size constraints were not checked' });
  } else {
    if (spec.width != null && w !== spec.width) add('width', `width is ${w}px, must be exactly ${spec.width}px`);
    if (spec.height != null && h !== spec.height) add('height', `height is ${h}px, must be exactly ${spec.height}px`);
    if (spec.minWidth != null && w < spec.minWidth) add('minWidth', `width ${w}px is below the minimum of ${spec.minWidth}px`);
    if (spec.maxWidth != null && w > spec.maxWidth) add('maxWidth', `width ${w}px is above the maximum of ${spec.maxWidth}px`);
    if (spec.minHeight != null && h < spec.minHeight) add('minHeight', `height ${h}px is below the minimum of ${spec.minHeight}px`);
    if (spec.maxHeight != null && h > spec.maxHeight) add('maxHeight', `height ${h}px is above the maximum of ${spec.maxHeight}px`);
    if (spec.aspect) {
      const [aw, ah] = spec.aspect.split(':').map(Number);
      if (w * ah !== h * aw) add('aspect', `aspect ratio is ${w}:${h}, must be ${spec.aspect}`);
    }
    if (spec.multipleOf && (w % spec.multipleOf || h % spec.multipleOf)) add('multipleOf', `${w}x${h} is not a multiple of ${spec.multipleOf}`);
  }
  if (spec.alpha === 'required' && info.alpha === false) add('alpha', 'image must have a transparency (alpha) channel');
  if (spec.alpha === 'required' && info.alpha === null) out.push({ level: 'warn', code: 'alpha-unknown', message: 'transparency could not be verified for this format' });
  if (spec.alpha === 'forbidden' && info.alpha === true) add('alpha', 'image must not have a transparency (alpha) channel');
  if (spec.maxBytes != null && info.bytes > spec.maxBytes) add('maxBytes', `file is ${info.bytes} bytes, limit is ${spec.maxBytes}`);
  if (info.unsafe) out.push({ level: 'error', code: 'svg-unsafe', message: 'SVG contains scripts, event handlers or foreignObject, which are not allowed' });
  return out;
}
