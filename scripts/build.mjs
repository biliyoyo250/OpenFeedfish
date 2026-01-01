import { mkdir, cp, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['frontend/app.js'], bundle: true, minify: true, format: 'esm', target: ['es2022'], outfile: 'dist/app.js' });
await build({ entryPoints: ['frontend/admin.js'], bundle: true, minify: true, format: 'esm', target: ['es2022'], outfile: 'dist/admin.js' });
await writeFile('dist/_routes.json', JSON.stringify({ version: 1, include: ['/api/*', '/admin', '/admin/*'], exclude: [] }));
console.log('Built dist/');
