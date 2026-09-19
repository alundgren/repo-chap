import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const platform = args.includes('--platform') ? value('--platform') : process.platform;
const arch = args.includes('--arch') ? value('--arch') : process.arch;
const out = args.includes('--out') ? value('--out') : undefined;
if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch) || !out || !isAbsolute(out)) {
  throw new Error('Use --out /absolute/directory with optional --platform linux|darwin and --arch x64|arm64.');
}
const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-package-'));
try {
  const source = join(temporary, 'source');
  await mkdir(source);
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  await cp('dist', join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'repo-chap-desktop', version: manifest.version, main: 'dist/main.cjs' }));
  const paths = await packager({ dir: source, tmpdir: join(temporary, 'scratch'), name: 'Repo Chap', executableName: 'repo-chap-desktop', appBundleId: 'dev.repo-chap.desktop', platform, arch, out: resolve(out), icon: platform === 'darwin' ? resolve('assets/icon.icns') : undefined, electronVersion: manifest.devDependencies.electron, prune: false, asar: true });
  console.log(paths.join('\n'));
} finally { await rm(temporary, { recursive: true, force: true }); }
