import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const operation = process.argv[2];
if (!['seed', 'reset'].includes(operation) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/local-db.mjs seed|reset');
}
if (operation === 'reset') {
  rmSync(new URL('../.wrangler/state/v3/d1/', import.meta.url), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--file=fixtures/seed.sql'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
