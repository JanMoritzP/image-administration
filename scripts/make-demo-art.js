// Generates a handful of pixel-art placeholders for the demo so the UI starts partially filled.
// Run: npm run demo:reset  (wipes examples/dungeon-dash/game first)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawPng } from '../src/png.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'dungeon-dash', 'game');
fs.rmSync(out, { recursive: true, force: true });
const put = (rel, buf) => { const f = path.join(out, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };

const wizard = (shift) => drawPng(32, 32, (x, y) => {
  const cx = 16, bob = shift % 2;
  const hat = y >= 3 + bob && y < 12 + bob && Math.abs(x - cx) <= (y - 3 - bob) / 1.4;
  const brim = y >= 12 + bob && y < 14 + bob && Math.abs(x - cx) <= 8;
  const face = y >= 14 + bob && y < 19 + bob && Math.abs(x - cx) <= 4;
  const cloak = y >= 19 + bob && y < 31 && Math.abs(x - cx) <= 6 + (y - 19 - bob) / 4;
  if (hat || brim) return [60, 90, 200];
  if (face) return [240, 200, 160];
  if (cloak) return [120, 80, 50];
  return [0, 0, 0, 0];
});
for (const dir of ['down', 'up']) for (let f = 0; f < 4; f++) put(`characters/hero/walk_${dir}_${String(f).padStart(2, '0')}.png`, wizard(f));

const slime = (f) => drawPng(32, 32, (x, y) => {
  const h = 10 + f * 2, w = 12 - f;
  const dy = y - (30 - h), dx = x - 16;
  return dy >= 0 && (dx * dx) / (w * w) + ((dy - h) * (dy - h)) / (h * h) <= 1 ? [80, 200, 90] : [0, 0, 0, 0];
});
for (let f = 0; f < 2; f++) put(`characters/slime/idle_${f}.png`, slime(f));

const checker = (a, b) => drawPng(16, 16, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? a : b, { alpha: false });
put('tiles/floor_stone.png', checker([120, 120, 128], [100, 100, 108]));
put('tiles/floor_moss.png', checker([90, 130, 80], [100, 100, 108]));

// Deliberately broken: wrong size, so the UI shows an "invalid" example.
put('tiles/wall_brick.png', drawPng(20, 16, (x, y) => ((y >> 2) % 2 ? [90, 40, 40] : [70, 30, 30]), { alpha: false }));

const heart = (fill) => drawPng(16, 16, (x, y) => {
  const dx = Math.abs(x - 7.5), dy = y - 5;
  const inside = (dx - 3) ** 2 + dy ** 2 < 14 || (dy > 0 && dx < 7 - dy * 0.8 + 1 && y < 14) ;
  return inside ? (fill ? [220, 40, 60] : [90, 90, 100]) : [0, 0, 0, 0];
});
put('ui/heart_full.png', heart(true));
console.log('Demo art written to', out);
