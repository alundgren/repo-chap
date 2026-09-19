import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/main.cjs' });
await build({ entryPoints: ['src/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/preload.cjs' });
await build({ entryPoints: ['src/renderer.ts'], bundle: true, platform: 'browser', format: 'iife', outfile: 'dist/renderer.js' });
await cp('src/index.html', 'dist/index.html');
await cp('src/styles.css', 'dist/styles.css');
await mkdir('dist/assets', { recursive: true });
await cp('assets/icon.png', 'dist/assets/icon.png');
await cp('assets/mascot.png', 'dist/assets/mascot.png');
await cp('../../docs/pr-workflows/assets/fonts', 'dist/fonts', { recursive: true });
