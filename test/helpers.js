import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a temp project dir from {relativePath: content}. */
export function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spriteadmin-'));
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return dir;
}
export const codes = (c, level) => c.diagnostics.filter((d) => !level || d.level === level).map((d) => d.code);
