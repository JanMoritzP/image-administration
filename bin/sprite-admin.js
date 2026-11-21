#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract, findManifest, MANIFEST_NAMES } from '../src/contract.js';
import { evaluateContract } from '../src/status.js';
import { createServer } from '../src/server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `sprite-admin - manage the sprites an app needs, driven by a Sprite Contract

Usage:
  sprite-admin [serve] [contract] [--port 4870] [--host 127.0.0.1]   open the admin UI
  sprite-admin validate [contract]                                   check the contract files (exit 1 on errors)
  sprite-admin status [contract] [--json] [--missing] [--check]      progress report
        --json     machine-readable report (see docs/CONTRACT.md "Status report")
        --missing  only list sprites that are not done, with their descriptions
        --check    exit 2 when required sprites are still missing (for CI)
  sprite-admin init [dir]                                            scaffold a starter contract
  sprite-admin schema                                                print the path of the JSON Schema

[contract] is a contract file or a directory containing ${MANIFEST_NAMES[0]} (default: current directory).`;

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); const next = args[i + 1]; if (['port', 'host'].includes(k)) { flags[k] = next; i++; } else flags[k] = true; }
  else pos.push(args[i]);
}
const commands = ['serve', 'validate', 'status', 'init', 'schema', 'help'];
const cmd = commands.includes(pos[0]) ? pos.shift() : 'serve';
const target = pos[0] ?? '.';

const color = process.stdout.isTTY ? (c, s) => `\x1b[${c}m${s}\x1b[0m` : (_, s) => s;
function printDiagnostics(list, base) {
  for (const x of list) {
    const tag = x.level === 'error' ? color(31, 'error  ') : color(33, 'warning');
    console.log(`${tag} ${path.relative(base, x.file) || x.file}${x.pointer ? ` ${x.pointer}` : ''}  [${x.code}] ${x.message}`);
  }
}
function bar(pct, w = 24) { const f = Math.round((pct / 100) * w); return `[${'#'.repeat(f)}${'.'.repeat(w - f)}]`; }

if (cmd === 'help' || flags.help || flags.h) { console.log(HELP); process.exit(0); }

if (cmd === 'schema') { console.log(path.join(ROOT, 'schema', 'sprite-contract.schema.json')); process.exit(0); }

if (cmd === 'init') {
  const dir = path.resolve(pos[0] ?? '.');
  const file = path.join(dir, MANIFEST_NAMES[0]);
  if (fs.existsSync(file)) { console.error(`${file} already exists`); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'examples', 'starter.sprites.yml'), file);
  console.log(`Created ${file}\nEdit it (see docs/CONTRACT.md), then run: sprite-admin serve ${pos[0] ?? '.'}`);
  process.exit(0);
}

const manifest = findManifest(target);
if (!manifest) { console.error(`No ${MANIFEST_NAMES.join(' / ')} found in "${target}". Run "sprite-admin init" to create one.`); process.exit(1); }
const base = path.dirname(manifest);

if (cmd === 'validate') {
  const c = loadContract(manifest);
  printDiagnostics(c.diagnostics, base);
  const errors = c.diagnostics.filter((d) => d.level === 'error').length;
  const warns = c.diagnostics.length - errors;
  console.log(`${c.sprites.length} sprites in ${c.files.length} file(s), ${errors} error(s), ${warns} warning(s)`);
  process.exit(errors ? 1 : 0);
}

if (cmd === 'status') {
  const rep = evaluateContract(loadContract(manifest));
  const s = rep.summary;
  if (flags.json) { console.log(JSON.stringify(rep, null, 2)); }
  else {
    console.log(`${rep.project?.name ?? 'project'}  ${bar(s.percent)} ${s.percent}%  (${s.done}/${s.total} done, ${s.missing} missing, ${s.partial} partial, ${s.invalid} invalid)`);
    if (rep.diagnostics.length) { console.log(''); printDiagnostics(rep.diagnostics, base); console.log(''); }
    for (const f of rep.folders.filter((f) => f.depth === 1)) console.log(`  ${f.title.padEnd(24)} ${bar(f.percent, 16)} ${f.done}/${f.total}`);
    if (flags.missing) {
      console.log('');
      for (const sp of rep.sprites.filter((x) => x.status !== 'available')) {
        const sz = [sp.spec.width && sp.spec.height ? `${sp.spec.width}x${sp.spec.height}` : null, sp.spec.formats.join('/')].filter(Boolean).join(' ');
        console.log(`- ${sp.id} [${sp.status}${sp.required ? '' : ', optional'}] ${sz}\n    ${sp.description}\n    -> ${sp.targets.map((t) => t.path).join(', ')}`);
      }
    }
  }
  const missingRequired = rep.sprites.some((x) => x.required && x.status !== 'available');
  process.exit(flags.check && (missingRequired || !rep.ok) ? 2 : 0);
}

// serve
const port = Number(flags.port ?? process.env.PORT ?? 4870);
const host = flags.host ?? '127.0.0.1';
const first = loadContract(manifest);
const errs = first.diagnostics.filter((d) => d.level === 'error');
if (errs.length) { printDiagnostics(first.diagnostics, base); console.log('\nThe contract has problems; the UI will show them and keep running.\n'); }
createServer(manifest, { host }).listen(port, host, () => {
  console.log(`Sprite admin for "${first.project?.name}" running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\nContract: ${manifest}\nPress Ctrl+C to stop.`);
}).on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use, try --port <n>` : e.message); process.exit(1); });
