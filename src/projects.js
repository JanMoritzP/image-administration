// Projects: each one is its own SQLite file with the same schema, so projects are fully separate (sprites, paths, history,
// events) and can be backed up or deleted one by one. The "default" project is the database the server was started with.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';

export const DEFAULT_PROJECT = 'default';
/** Lower-case letters, digits and dashes: it is used in file names and URLs. */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db  the default project
 * @param {string|null} [o.dir]  folder for the other projects' files (`<id>.db`); null keeps them in memory (tests)
 */
export function createProjects({ db, dir = null }) {
  const open = new Map([[DEFAULT_PROJECT, db]]);
  const file = (id) => path.join(dir, `${id}.db`);
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const id = f.endsWith('.db') ? f.slice(0, -3) : '';
      if (PROJECT_ID_RE.test(id) && id !== DEFAULT_PROJECT) open.set(id, openDb(file(id)));
    }
  }
  return {
    /** The database of a project, or null when there is none. */
    get: (id) => open.get(id) ?? null,
    /** The database of a project, created when it does not exist yet. */
    ensure(id) {
      let d = open.get(id);
      if (!d) { d = openDb(dir ? file(id) : ':memory:'); open.set(id, d); }
      return d;
    },
    /** Ids, the default project first, the others sorted. */
    ids: () => [DEFAULT_PROJECT, ...[...open.keys()].filter((k) => k !== DEFAULT_PROJECT).sort()],
    /** Deletes a project with all its images. The default project cannot be removed. */
    remove(id) {
      const d = open.get(id);
      if (!d || id === DEFAULT_PROJECT) return false;
      open.delete(id);
      d.close();
      if (dir) for (const ext of ['', '-wal', '-shm']) fs.rmSync(file(id) + ext, { force: true });
      return true;
    },
    close() { for (const [id, d] of open) if (id !== DEFAULT_PROJECT) d.close(); },
  };
}
