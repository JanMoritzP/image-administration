import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import YAML from 'yaml';
import { loadContract } from '../src/contract.js';
import { tmpProject, codes } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the demo contract loads cleanly across yml + json includes', () => {
  const c = loadContract(path.join(ROOT, 'examples/dungeon-dash'));
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(c.files.length, 4);
  assert.equal(c.sprites.length, 30);
  assert.deepEqual(c.folders.slice(0, 3).map((f) => f.id), ['characters', 'characters/hero', 'characters/slime']);
});

test('matrix expands, pads numbers and fills target templates', () => {
  const c = loadContract(path.join(ROOT, 'examples/dungeon-dash'));
  const s = c.sprites.find((x) => x.id === 'characters/hero/walk-left-03');
  assert.equal(s.targets[0].path, 'characters/hero/walk_left_03.png');
  assert.match(s.description, /walking left\. Frame 3 of 4/);
  assert.equal(s.spec.width, 32); // folder default
});

test('defaults layer: root < file < folder < sprite, spec merges per key', () => {
  const c = loadContract(path.join(ROOT, 'examples/dungeon-dash'));
  const portrait = c.sprites.find((x) => x.id === 'characters/hero/portrait');
  assert.equal(portrait.spec.width, 64); // sprite overrides folder
  assert.equal(portrait.spec.alpha, 'required'); // root default survives the merge
  assert.equal(portrait.targets.length, 2);
  const torch = c.sprites.find((x) => x.id === 'tiles/wall/torch');
  assert.equal(torch.spec.alpha, 'any'); // sprite beats the json file default 'forbidden'
  const heart = c.sprites.find((x) => x.id === 'ui/hud/heart-full');
  assert.deepEqual(heart.tags, ['pixel-art']);
  assert.equal(c.sprites.find((x) => x.id === 'characters/skeleton/idle').required, false);
});

test('defaults.targets with {id} template gives one-line sprites', () => {
  const dir = tmpProject({ 'sprites.contract.yml': `
contract: "1.0"
project: { name: T }
defaults: { targets: ["assets/{id}.png"] }
sprites:
  - { id: a/b, description: d }
` });
  const c = loadContract(dir);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  assert.equal(c.sprites[0].targets[0].path, 'assets/a/b.png');
});

test('diagnostics: the common mistakes are all reported with codes', () => {
  const dir = tmpProject({
    'sprites.contract.yml': `
contract: "1.0"
project: { name: T, root: out }
include: [missing.yml, "parts/*.yml"]
sprites:
  - { id: dup, description: x, target: a.png }
  - { id: dup, description: x, target: b.png }
  - { id: esc, description: x, target: ../outside.png }
  - { id: ext, description: x, target: file.bmp }
  - { id: ph, description: "x {nope}", target: ph.png }
  - { id: clash, description: x, target: a.png }
  - { id: nodesc, target: n.png }
  - { id: nodest, description: x }
  - { id: typo, descripton: x, description: y, target: t.png, spec: { widht: 3 } }
  - { id: fmt, description: x, target: f.png, spec: { formats: [webp] } }
  - { id: badspec, description: x, target: bs.png, spec: { width: -4 } }
`,
    'parts/one.yml': `contract: "9.0"\nsprites: []`,
  });
  const c = loadContract(dir);
  const got = new Set(codes(c));
  for (const code of ['include-missing', 'duplicate-id', 'target-escape', 'target-extension', 'unknown-placeholder', 'target-conflict', 'missing-description', 'no-targets', 'unknown-key', 'target-format-mismatch', 'invalid-value', 'unsupported-version'])
    assert.ok(got.has(code), `expected diagnostic ${code}, got ${[...got]}`);
  assert.equal(c.ok, false);
  assert.ok(c.diagnostics.find((d) => d.code === 'unknown-key' && /widht/.test(d.message) && /width/.test(d.message)), 'suggests the correct key');
  // valid sprites still load despite the errors elsewhere
  assert.deepEqual(c.sprites.map((s) => s.id).sort(), ['dup', 'typo']);
});

test('missing manifest and broken yaml do not throw', () => {
  const a = loadContract('/definitely/not/here');
  assert.equal(a.ok, false); assert.ok(a.fatal);
  const b = loadContract(tmpProject({ 'sprites.contract.yml': 'contract: [unclosed' }));
  assert.equal(b.ok, false); assert.ok(codes(b).includes('parse-error'));
});

test('include cycles are rejected, glob matches are sorted', () => {
  const dir = tmpProject({
    'sprites.contract.yml': 'contract: "1.0"\nproject: {name: T}\ninclude: sub/a.yml\n',
    'sub/a.yml': 'contract: "1.0"\ninclude: ../sprites.contract.yml\n',
  });
  assert.ok(codes(loadContract(dir)).includes('include-cycle'));
});

test('examples validate against the JSON Schema (yml and json)', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/sprite-contract.schema.json'), 'utf8')));
  const files = ['examples/dungeon-dash/sprites.contract.yml', 'examples/dungeon-dash/contracts/characters.yml', 'examples/dungeon-dash/contracts/ui.yml', 'examples/dungeon-dash/contracts/tiles.json', 'examples/starter.sprites.yml'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const doc = f.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
    assert.ok(validate(doc), `${f}: ${ajv.errorsText(validate.errors)}`);
  }
  assert.equal(validate({ contract: '1.0', sprites: [{ id: 'x' }] }), false, 'description is required');
});
