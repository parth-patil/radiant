// Build distribution artifacts locally. Tauri handles signing with its standard environment variables.
import { fileURLToPath } from 'node:url';

const endpoint = process.env.RADIANT_UPDATE_ENDPOINT;
const pubkey = process.env.RADIANT_UPDATE_PUBKEY;
if (!endpoint || !pubkey || new URL(endpoint).protocol !== 'https:') {
  throw new Error('Set RADIANT_UPDATE_ENDPOINT to an HTTPS release manifest and RADIANT_UPDATE_PUBKEY to the updater public key.');
}
const project = fileURLToPath(new URL('../', import.meta.url));
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: project, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  const status = await child.exited;
  if (status !== 0) process.exit(status);
}

const report = process.env.RADIANT_DEPENDENCY_REPORT;
await run(['bun', 'run', 'deps:audit', ...(report ? ['--report', report] : [])]);
await run(['bun', 'install', '--frozen-lockfile']);
const config = { bundle: { createUpdaterArtifacts: true }, plugins: { updater: { endpoints: [endpoint], pubkey } } };
await run(['bun', 'run', 'tauri', 'build', '--config', JSON.stringify(config), '--', '--locked']);
