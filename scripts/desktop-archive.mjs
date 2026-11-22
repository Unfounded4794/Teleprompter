import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'desktop');
const require = createRequire(join(desktop, 'package.json'));
const JSZip = require('jszip');
const plist = require('plist');
const { createPackage } = require('@electron/asar');
const { downloadArtifact } = await import(pathToFileURL(require.resolve('@electron/get')).href);
const config = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const selected = process.argv.slice(2);
const targets = selected.length ? selected : ['mac-arm64', 'mac-x64', 'linux-x64'];
const options = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
};
if (targets.some(target => !Object.hasOwn(options, target))) throw new Error('Choose mac-arm64, mac-x64, linux-x64, or linux-arm64.');

const output = join(root, 'release');
const stagingRoot = join(root, '.local', 'desktop-build');
await mkdir(output, { recursive: true });
await mkdir(stagingRoot, { recursive: true });
const stage = await mkdtemp(join(stagingRoot, 'app-'));
const appSource = join(stage, 'app');
try {
  await mkdir(appSource);
  for (const name of ['main.cjs', 'preload.cjs', 'certificates.cjs', 'ui']) {
    await cp(join(desktop, name), join(appSource, name), { recursive: true });
  }
  await writeFile(join(appSource, 'package.json'), JSON.stringify({
    name: config.name, productName: config.productName, version: config.version, main: config.main,
  }));
  for (const name of Object.keys(config.dependencies)) {
    await copyDependency(name, desktop, join(appSource, 'node_modules'));
  }
  const asarPath = join(stage, 'app.asar');
  await createPackage(appSource, asarPath);
  const asar = await readFile(asarPath);
  const resources = [
    ['dist', join(root, 'dist')],
    ['server.mjs', join(root, 'server.mjs')],
    ['scripts/local-network.mjs', join(root, 'scripts/local-network.mjs')],
    ['scripts/prepare-voice.mjs', join(root, 'scripts/prepare-voice.mjs')],
    ['scripts/lan-profile.mjs', join(root, 'scripts/lan-profile.mjs')],
    ['bundled-models/base', join(root, '.local/models/base')],
    ['bundled-models/tiny', join(root, '.local/models/tiny')],
  ];
  for (const target of targets) {
    const { platform, arch } = options[target];
    console.log('Preparing ' + target);
    const zipPath = await downloadArtifact({
      version: config.devDependencies.electron, artifactName: 'electron', platform, arch,
      cacheRoot: process.env.ELECTRON_CACHE,
    });
    const source = await JSZip.loadAsync(await readFile(zipPath));
    const zip = new JSZip();
    const mac = platform === 'darwin';
    const appFolder = 'Teleprompter Setup.app';
    const prefix = mac ? appFolder + '/Contents/Resources/' : 'Teleprompter Setup/resources/';
    for (const entry of Object.values(source.files)) {
      if (entry.name === 'resources/default_app.asar' || entry.name.endsWith('/Resources/default_app.asar')) continue;
      const name = mac ? entry.name.replace(/^Electron\.app/, appFolder) : 'Teleprompter Setup/' + entry.name;
      const finalName = !mac && name === 'Teleprompter Setup/electron' ? 'Teleprompter Setup/Teleprompter Setup' : name;
      if (entry.dir) zip.file(finalName, null, { dir: true, unixPermissions: entry.unixPermissions || 0o40755 });
      else {
        let contents = entry.async('nodebuffer');
        if (mac && entry.name.endsWith('.app/Contents/Info.plist')) {
          const info = plist.parse(await entry.async('string'));
          if (!info.CFBundleExecutable && info.CFBundleName) {
            info.CFBundleExecutable = info.CFBundleName;
            contents = Promise.resolve(Buffer.from(plist.build(info)));
          }
        }
        zip.file(finalName, contents, {
        unixPermissions: entry.unixPermissions || 0o100644, binary: true, date: entry.date,
        compression: (entry.unixPermissions & 0o170000) === 0o120000 || entry.name.endsWith('.pak') ? 'STORE' : 'DEFLATE',
        });
      }
    }
    zip.file(prefix + 'app.asar', asar, { unixPermissions: 0o100644 });
    for (const [destination, from] of resources) await addPath(zip, from, prefix + 'teleprompter/' + destination);
    if (mac) {
      const infoPath = appFolder + '/Contents/Info.plist';
      const info = plist.parse(await source.file('Electron.app/Contents/Info.plist').async('string'));
      Object.assign(info, {
        CFBundleName: config.productName, CFBundleDisplayName: config.productName,
        CFBundleIdentifier: 'local.teleprompter.setup', CFBundleShortVersionString: config.version,
        CFBundleVersion: config.version, CFBundleIconFile: 'teleprompter.icns',
        NSHumanReadableCopyright: 'Teleprompter',
      });
      delete info.ElectronAsarIntegrity;
      zip.file(infoPath, plist.build(info), { unixPermissions: 0o100644 });
      const icon = await readFile(join(root, 'public/icon-512.png'));
      const header = Buffer.alloc(16);
      header.write('icns', 0);
      header.writeUInt32BE(icon.length + 16, 4);
      header.write('ic09', 8);
      header.writeUInt32BE(icon.length + 8, 12);
      zip.file(prefix + 'teleprompter.icns', Buffer.concat([header, icon]), { unixPermissions: 0o100644 });
    }
    const readme = mac
      ? 'Move Teleprompter Setup.app to Applications and open it. This build is unsigned. macOS may require approval in System Settings > Privacy & Security > Open Anyway.\n'
      : 'Extract the full Teleprompter Setup folder and open the Teleprompter Setup executable inside it. Keep the folder contents together.\n';
    zip.file('Read me.txt', readme + '\nOpen Teleprompter starts the editor in your browser. Start phone setup shows a QR code for installing on iPhone or iPad over your local network. Lightweight and Compact voice recognition are included. Try Lightweight on older phones. Keep the launcher open while installing or using a paired display.\n', { unixPermissions: 0o100644 });
    const filename = 'Teleprompter-Setup-' + (mac ? 'macOS-' : 'Linux-') + arch + '.zip';
    await pipeline(zip.generateNodeStream({
      type: 'nodebuffer', platform: 'UNIX', streamFiles: true,
      compression: 'DEFLATE', compressionOptions: { level: 6 },
    }), createWriteStream(join(output, filename)));
    console.log('Created ' + filename);
    if (mac) await signMacArchive(join(output, filename));
  }
} finally {
  if (dirname(stage) !== stagingRoot) throw new Error('Invalid packaging folder.');
  await rm(stage, { recursive: true, force: true });
}

async function copyDependency(name, from, to) {
  const resolver = createRequire(join(from, 'package.json'));
  let packageFile;
  try { packageFile = resolver.resolve(name + '/package.json'); }
  catch {
    let location = dirname(resolver.resolve(name));
    while (location !== dirname(location)) {
      try {
        const found = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
        if (found.name === name) { packageFile = join(location, 'package.json'); break; }
      } catch { /* Continue to the package root. */ }
      location = dirname(location);
    }
  }
  if (!packageFile) throw new Error('Could not package dependency ' + name);
  const directory = dirname(packageFile);
  const target = join(to, ...name.split('/'));
  await cp(directory, target, { recursive: true, filter: path => {
    const local = relative(directory, path);
    return !local.split(/[\\/]/).includes('node_modules');
  } });
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  for (const dependency of Object.keys(metadata.dependencies || {})) {
    await copyDependency(dependency, directory, join(target, 'node_modules'));
  }
}

async function addPath(zip, from, target) {
  if ((await stat(from)).isDirectory()) {
    for (const entry of await readdir(from)) await addPath(zip, join(from, entry), target + '/' + entry);
  } else {
    zip.file(target, await readFile(from), { unixPermissions: 0o100644 });
  }
}

async function signMacArchive(archive) {
  const outputPath = archive.replace(/\.zip$/, '.tar.gz');
  const script = join(root, 'scripts/sign-mac.sh');
  let result;
  if (process.platform === 'win32') {
    const distro = process.env.TELEPROMPTER_WSL_DISTRIBUTION;
    const signer = process.env.TELEPROMPTER_RCODESIGN;
    if (!distro || !signer) throw new Error('Mac archives require TELEPROMPTER_WSL_DISTRIBUTION and TELEPROMPTER_RCODESIGN, or a native Mac build.');
    const linuxPath = path => {
      const converted = spawnSync('wsl.exe', ['-d', distro, '--', 'wslpath', '-u', path.replaceAll('\\', '/')], { encoding: 'utf8', windowsHide: true });
      if (converted.status !== 0) throw new Error(converted.stderr || 'Could not convert the archive path.');
      return converted.stdout.trim();
    };
    result = spawnSync('wsl.exe', ['-d', distro, '--', '/bin/sh', linuxPath(script), linuxPath(archive), linuxPath(outputPath), linuxPath(signer),
      process.env.TELEPROMPTER_SIGN_TMPDIR || '/tmp'], { stdio: 'inherit', windowsHide: true });
  } else {
    const signer = process.platform === 'darwin' ? 'codesign' : process.env.TELEPROMPTER_RCODESIGN;
    if (!signer) throw new Error('Set TELEPROMPTER_RCODESIGN to sign the Mac archive.');
    result = spawnSync('/bin/sh', [script, archive, outputPath, signer], { stdio: 'inherit' });
  }
  if (result.status !== 0) throw new Error('Mac archive signing failed.');
  await rm(archive);
  console.log('Created ' + outputPath);
}

