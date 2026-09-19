import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'bundle', outfile: 'dist/cli.js' });
await rm('dist/skill', { recursive: true, force: true });
await cp('../../skills/repo-chap-workflows', 'dist/skill', { recursive: true });
