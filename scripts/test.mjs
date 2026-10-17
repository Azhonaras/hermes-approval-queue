/** Runs every *.test.mjs under test/ (node --test needs explicit files on Node 18-22). */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2]; // "unit" | "e2e" | undefined
const dirs = only ? [only] : ['unit', 'e2e'];
const files = dirs.flatMap((d) =>
  readdirSync(path.join(root, 'test', d)).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('test', d, f)));

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
