#!/usr/bin/env node
// Image Administration server. Configuration comes from environment variables (Docker) or flags (local use).
import crypto from 'node:crypto';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const HELP = `image-administration: image requests, uploads and delivery over HTTP, stored in SQLite

Usage: sprite-admin [--port 4870] [--host 127.0.0.1] [--data ./data] [--token <t>]
                    [--webhook <url>] [--webhook-token <t>] [--public-files] [--max-upload-mb 50]

Every option has an environment variable:
  PORT, HOST, DATA_DIR (holds image-admin.db), ADMIN_TOKEN, WEBHOOK_URL, WEBHOOK_TOKEN, PUBLIC_FILES=1, MAX_UPLOAD_MB

ADMIN_TOKEN is the password of the web UI and the bearer token of the API. If unset, a random one is generated and printed.`;

const VALUE_FLAGS = ['port', 'host', 'data', 'token', 'webhook', 'webhook-token', 'max-upload-mb'];
const flags = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) { console.error(`unexpected argument "${args[i]}"\n\n${HELP}`); process.exit(1); }
  const k = args[i].slice(2);
  if (VALUE_FLAGS.includes(k)) { flags[k] = args[++i]; if (flags[k] === undefined) { console.error(`--${k} needs a value`); process.exit(1); } }
  else flags[k] = true;
}
if (flags.help || flags.h) { console.log(HELP); process.exit(0); }

const env = process.env;
const port = Number(flags.port ?? env.PORT ?? 4870);
const host = flags.host ?? env.HOST ?? '127.0.0.1';
const dataDir = path.resolve(flags.data ?? env.DATA_DIR ?? 'data');
const dbFile = path.join(dataDir, 'image-admin.db');
let token = flags.token ?? env.ADMIN_TOKEN;
const generated = !token;
if (generated) token = crypto.randomBytes(24).toString('base64url');
const webhookUrl = flags.webhook ?? env.WEBHOOK_URL;
const webhook = webhookUrl ? { url: webhookUrl, token: flags['webhook-token'] ?? env.WEBHOOK_TOKEN } : undefined;
const publicFiles = !!flags['public-files'] || ['1', 'true'].includes(env.PUBLIC_FILES ?? '');
const maxMb = Number(flags['max-upload-mb'] ?? env.MAX_UPLOAD_MB ?? 50);

const db = openDb(dbFile);
const projectsDir = path.join(dataDir, 'projects');
const server = createServer({ db, token, webhook, publicFiles, host, maxUploadBytes: maxMb * 1024 * 1024, projectsDir });
server.listen(port, host, () => {
  console.log(`Image Administration running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Database: ${dbFile} (project "default"); other projects: ${projectsDir}`);
  console.log(generated ? `Admin token (generated, changes on every start; set ADMIN_TOKEN to keep one): ${token}` : 'Admin token: from ADMIN_TOKEN / --token');
  console.log(`Webhook: ${webhook ? webhook.url : 'none'} · files served ${publicFiles ? 'publicly' : 'with token only'}`);
}).on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use, try --port <n>` : e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
