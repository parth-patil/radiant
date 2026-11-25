// Checks locked dependencies before distribution. No registry access during normal development.
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const npmRegistry = 'https://registry.npmjs.org';
const osv = 'https://api.osv.dev/v1/querybatch';
const approved = new Set([
  '0BSD', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception', 'BSD-2-Clause', 'BSD-3-Clause',
  'CC0-1.0', 'ISC', 'MIT', 'MIT-0', 'MPL-2.0', 'PSF-2.0', 'Unicode-3.0', 'Unlicense', 'Zlib'
]);

type InventoryNote = { purpose: string; rationale: string; boundary: string; licenses: string[] };
type Component = {
  ecosystem: 'npm' | 'crates.io';
  name: string;
  version: string;
  license: string | null;
  description: string | null;
  direct: boolean;
};
type CargoPackage = {
  id: string; source: string | null; name: string; version: string; license: string | null;
  description: string | null; dependencies: { name: string }[];
};
type AdvisoryPage = { vulns?: { id: string; modified?: string }[]; next_page_token?: string };

function command(args: string[]): string {
  const child = Bun.spawnSync(args, { cwd: project, stdout: 'pipe', stderr: 'inherit' });
  if (child.exitCode !== 0) throw new Error(`${args.join(' ')} exited with ${child.exitCode}`);
  return child.stdout.toString();
}

async function json<T>(url: string, request?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...request, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json() as T;
}

async function chunks<T, R>(items: T[], count: number, get: (items: T[]) => Promise<R[]>): Promise<R[]> {
  const result: R[] = [];
  for (let start = 0; start < items.length; start += count) {
    result.push(...await get(items.slice(start, start + count)));
  }
  return result;
}

function licensePermitted(component: Component): boolean {
  if (!component.license) return false;
  // Old crates.io manifests used a slash for alternative licensing. npm's rgbcolor
  // explicitly offers MIT as an alternative to its non-SPDX file-based terms.
  let expression = component.license;
  if (component.ecosystem === 'crates.io') expression = expression.replaceAll('/', ' OR ');
  if (component.ecosystem === 'npm' && component.name === 'rgbcolor' && component.version === '1.0.1' &&
      expression === 'MIT OR SEE LICENSE IN FEEL-FREE.md') expression = 'MIT';
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+-]+/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, '')) return false;
  let i = 0;
  function term(): boolean {
    const token = tokens[i++];
    if (token === '(') {
      const result = alternatives();
      if (tokens[i++] !== ')') throw new Error('Invalid licence expression');
      return result;
    }
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token)) throw new Error('Invalid licence expression');
    if (tokens[i] !== 'WITH') return approved.has(token);
    i++;
    const exception = tokens[i++];
    if (!exception || ['AND', 'OR', 'WITH', '(', ')'].includes(exception)) throw new Error('Invalid licence exception');
    return approved.has(`${token} WITH ${exception}`);
  }
  function conjunction(): boolean {
    let result = term();
    while (tokens[i] === 'AND') {
      i++;
      const next = term();
      result = result && next;
    }
    return result;
  }
  function alternatives(): boolean {
    let result = conjunction();
    while (tokens[i] === 'OR') {
      i++;
      const next = conjunction();
      result = result || next;
    }
    return result;
  }
  try { return alternatives() && i === tokens.length; }
  catch { return false; }
}

async function npmComponents(lock: string): Promise<{ components: Component[]; direct: string[] }> {
  const manifest = await Bun.file(project + 'package.json').json();
  const resolved = Bun.JSON5.parse(lock);
  if (resolved.lockfileVersion !== 2 || !resolved.workspaces?.[''] || !resolved.packages) {
    throw new Error('Unsupported Bun lockfile format');
  }
  const direct = new Set<string>();
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const declared = Object.entries(manifest[group] ?? {}).sort();
    const locked = Object.entries(resolved.workspaces[''][group] ?? {}).sort();
    if (JSON.stringify(declared) !== JSON.stringify(locked)) throw new Error(`bun.lock is out of date for ${group}`);
    for (const [name] of declared) direct.add('npm:' + name);
  }
  const directReleases = new Set([...direct].map(key => resolved.packages[key.slice(4)]?.[0]));
  if (directReleases.has(undefined)) throw new Error('Missing a direct npm lock record');
  const releases = new Map<string, { name: string; version: string; integrity: string }>();
  for (const value of Object.values(resolved.packages)) {
    if (!Array.isArray(value)) throw new Error('Unsupported Bun lockfile record');
    const [release, registry] = value;
    const integrity = value.at(-1);
    const parts = typeof release === 'string' && /^(@[^/]+\/[^@]+|[^@]+)@([0-9][0-9A-Za-z.+-]*)$/.exec(release);
    if (!parts || registry !== '' || typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
      throw new Error(`Unverified npm source or integrity: ${release}`);
    }
    const existing = releases.get(release);
    if (existing && existing.integrity !== integrity) throw new Error(`Inconsistent npm lock integrity: ${release}`);
    releases.set(release, { name: parts[1], version: parts[2], integrity });
  }
  const components = await chunks([...releases.values()], 16, entries => Promise.all(entries.map(async ({ name, version, integrity }) => {
    const info = await json<{ name: string; version: string; dist?: { integrity?: string };
      license?: string; description?: string }>(`${npmRegistry}/${encodeURIComponent(name)}/${version}`);
    if (info.name !== name || info.version !== version || info.dist?.integrity !== integrity) {
      throw new Error(`npm registry identity or integrity differs from bun.lock: ${name}@${version}`);
    }
    return { ecosystem: 'npm' as const, name, version, license: info.license ?? null,
      description: info.description ?? null, direct: directReleases.has(`${name}@${version}`) };
  })));
  for (const name of direct) {
    if (!components.some(component => 'npm:' + component.name === name)) throw new Error(`Missing locked dependency: ${name}`);
  }
  return { components, direct: [...direct] };
}

function cargoComponents(target: string): { components: Component[]; direct: string[] } {
  const manifest = ['--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'tauri/custom-protocol'];
  const metadata = JSON.parse(command(['cargo', 'metadata', ...manifest, '--format-version', '1',
    '--filter-platform', target])) as {
    packages: CargoPackage[]; resolve: { root: string; nodes: { id: string; deps: { pkg: string }[] }[] };
  };
  const { packages, resolve } = metadata;
  const root = packages.find(pkg => pkg.id === resolve.root);
  if (!root) throw new Error('Cargo did not resolve the application crate');
  // Cargo metadata can include optional dependency edges that the build does not activate.
  // Take release membership from the locked build tree and use metadata for package facts.
  const tree = command(['cargo', 'tree', ...manifest, '--target', target, '--edges', 'normal,build',
    '--prefix', 'none', '--format', '{p}']).trim().split(/\r?\n/);
  if (!tree.shift()?.startsWith(`${root.name} v${root.version} (`)) {
    throw new Error('Cargo build tree did not start at the application crate');
  }
  const remaining = new Set(tree.map(line => line.replace(/(?: \(proc-macro\))?(?: \(\*\))?$/, '')));
  const directPackages = new Set(resolve.nodes.find(({ id }) => id === root.id)?.deps.map(dep => dep.pkg));
  const components = packages.filter(pkg => remaining.delete(`${pkg.name} v${pkg.version}`)).map(pkg => {
    if (pkg.source !== 'registry+https://github.com/rust-lang/crates.io-index') {
      throw new Error(`Unverified Cargo source: ${pkg.name}@${pkg.version}`);
    }
    return { ecosystem: 'crates.io' as const, name: pkg.name, version: pkg.version,
      license: pkg.license, description: pkg.description, direct: directPackages.has(pkg.id) };
  });
  if (remaining.size) throw new Error(`Unverified Cargo build tree entries: ${[...remaining].join(', ')}`);
  return { components, direct: [...new Set(root.dependencies.map(dep => 'crates.io:' + dep.name))] };
}

async function advisories(components: Component[]) {
  return chunks(components, 100, async batch => {
    const queries = batch.map(({ ecosystem, name, version }) => ({ package: { ecosystem, name }, version }));
    const hits: { component: string; id: string; modified?: string }[] = [];
    let pending = queries.map((query, componentIndex) => ({ query, componentIndex }));
    while (pending.length) {
      const report = await json<{ results?: AdvisoryPage[] }>(osv, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: pending.map(entry => entry.query) })
      });
      if (!Array.isArray(report.results) || report.results.length !== pending.length) {
        throw new Error('OSV returned an incomplete advisory report');
      }
      pending = report.results.flatMap((page, index) => {
        const { componentIndex, query } = pending[index];
        const { ecosystem, name, version } = batch[componentIndex];
        for (const issue of page.vulns ?? []) {
          if (!issue.id) throw new Error('OSV returned an advisory without an ID');
          hits.push({ component: `${ecosystem}:${name}@${version}`, id: issue.id, modified: issue.modified });
        }
        if (!page.next_page_token) return [];
        if ('page_token' in query && query.page_token === page.next_page_token) throw new Error('OSV repeated a page token');
        return [{ componentIndex, query: { ...query, page_token: page.next_page_token } }];
      });
    }
    return hits;
  });
}

const args = Bun.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--report')) {
  throw new Error('Usage: bun tools/check-dependencies.ts [--report report.json]');
}
const target = process.env.CARGO_BUILD_TARGET || /^host: (.+)$/m.exec(command(['rustc', '-vV']))?.[1];
if (!target) throw new Error('Could not determine the native release target');
const cargoLock = await Bun.file(project + 'src-tauri/Cargo.lock').text();
const npmLock = await Bun.file(project + 'bun.lock').text();
const cargo = cargoComponents(target);
const npm = await npmComponents(npmLock);
const notes = await Bun.file(project + 'requirements/dependencies.json').json() as Record<string, InventoryNote>;
const direct = new Set([...npm.direct, ...cargo.direct]);
for (const name of direct) {
  const note = notes[name];
  if (!note?.purpose.trim() || !note.rationale.trim() || !note.boundary.trim()) {
    throw new Error(`Missing direct dependency inventory entry: ${name}`);
  }
}
for (const name of Object.keys(notes)) {
  if (!direct.has(name)) throw new Error(`Stale dependency inventory entry: ${name}`);
}
const components = [...npm.components, ...cargo.components].sort((a, b) =>
  `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(`${b.ecosystem}:${b.name}@${b.version}`, 'en'));
const inventory = components.map(component => {
  const { direct: isDirect, ...identity } = component;
  const note = isDirect ? notes[`${component.ecosystem}:${component.name}`] : undefined;
  return {
    ...identity, kind: isDirect ? 'direct' : 'transitive',
    purpose: note?.purpose ?? component.description,
    rationale: note?.rationale ?? 'Resolved by a locked direct or transitive dependency.',
    boundary: note?.boundary ?? 'Through the depending library or build tool.',
    licensePermitted: licensePermitted(component) &&
      (!note || (component.license !== null && note.licenses.includes(component.license)))
  };
});
const blocked = inventory.filter(component => !component.licensePermitted);
for (const item of blocked) console.error(`Unapproved license: ${item.ecosystem}:${item.name}@${item.version} (${item.license ?? 'undeclared'})`);
const hits = await advisories(components);
for (const issue of hits) console.error(`${issue.component}: https://osv.dev/vulnerability/${issue.id}`);
const report = {
  target, checkedAt: new Date().toISOString(), sources: { npmRegistry, osv },
  lockSha256: { bun: Bun.CryptoHasher.hash('sha256', npmLock, 'hex'),
    cargo: Bun.CryptoHasher.hash('sha256', cargoLock, 'hex') },
  inventory, advisories: hits
};
if (args[1]) await Bun.write(args[1], JSON.stringify(report, null, 2) + '\n');
console.log(`Audited ${npm.components.length} npm packages and ${cargo.components.length} Cargo packages for ${target}. ` +
  `${blocked.length} unapproved licenses, ${hits.length} advisory matches.`);
if (blocked.length || hits.length) process.exitCode = 1;
