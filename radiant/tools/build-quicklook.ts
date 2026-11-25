import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, parse } from 'plist';

if (process.platform !== 'darwin') throw new Error('Building the Quick Look extension requires macOS.');

const native = fileURLToPath(new URL('../src-tauri/', import.meta.url));
const source = join(native, 'quicklook');
const base = await Bun.file(join(native, 'tauri.conf.json')).json();
const mac = await Bun.file(join(native, 'tauri.macos.conf.json')).json();
const overrides = JSON.parse(process.env.TAURI_CONFIG || '{}');
const metadata = { ...base, ...mac, ...overrides };
const macBundle = { ...base.bundle?.macOS, ...mac.bundle.macOS, ...overrides.bundle?.macOS };
const version = /^\d+\.\d+\.\d+(?:[+-]|$)/.test(metadata.version)
  ? metadata.version
  : (await Bun.file(resolve(native, metadata.version)).json()).version;
const identity = process.env.APPLE_SIGNING_IDENTITY || macBundle.signingIdentity || '-';
if (process.env.APPLE_CERTIFICATE && identity === '-') {
  throw new Error('Select the matching macOS signing identity with APPLE_SIGNING_IDENTITY before bundling the Quick Look extension.');
}

async function run(...args: string[]): Promise<void> {
  const code = await Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' }).exited;
  if (code !== 0) throw new Error(`${args[0]} failed with exit code ${code}`);
}

const name = 'RadiantQuickLook';
const scratch = await mkdtemp(join(source, '.build-'));
const extension = join(scratch, name + '.appex');
const contents = join(extension, 'Contents');
const binaries = join(contents, 'MacOS');
const resources = join(contents, 'Resources');
try {
  await mkdir(binaries, { recursive: true });
  await mkdir(resources, { recursive: true });
  const plist = parse(await Bun.file(join(source, 'Info.plist')).text()) as Record<string, unknown>;
  plist.CFBundleIdentifier = metadata.identifier + '.quicklook';
  plist.CFBundleShortVersionString = version;
  plist.CFBundleVersion = macBundle.bundleVersion || version;
  await Bun.write(join(contents, 'Info.plist'), build(plist));
  await copyFile(join(source, 'index.html'), join(resources, 'index.html'));

  const sdk = Bun.spawnSync(['xcrun', '--sdk', 'macosx', '--show-sdk-path']);
  if (!sdk.success) throw new Error('Install Xcode or the macOS Command Line Tools to build Quick Look.');
  const architectures = ['arm64', 'x86_64'];
  const slices = architectures.map(arch => join(scratch, arch));
  await Promise.all([
    run('bun', 'build', join(source, 'preview.ts'), '--target=browser', '--format=iife', '--minify',
      '--outfile', join(resources, 'preview.js')),
    ...architectures.map((arch, index) => run('xcrun', 'swiftc', '-sdk', sdk.stdout.toString().trim(),
      '-target', `${arch}-apple-macos${plist.LSMinimumSystemVersion}`, '-application-extension',
      '-parse-as-library', '-module-name', name, '-O', '-framework', 'QuickLookUI', '-framework', 'WebKit',
      '-lsqlite3', '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain', join(source, 'PreviewController.swift'),
      '-o', slices[index]))
  ]);
  await run('xcrun', 'lipo', '-create', ...slices, '-output', join(binaries, name));
  await run('/usr/bin/plutil', '-lint', join(contents, 'Info.plist'));
  await run('/usr/bin/codesign', '--force', '--sign', identity,
    ...(identity === '-' ? ['--timestamp=none'] : ['--timestamp', '--options', 'runtime']),
    '--entitlements', join(source, 'Entitlements.plist'), extension);
  await run('/usr/bin/codesign', '--verify', '--strict', extension);

  const destination = join(source, '.bundle', name + '.appex');
  await mkdir(join(source, '.bundle'), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(extension, destination);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
