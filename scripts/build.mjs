import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
// Rebuild from scratch so removed assets cannot linger in the published output.
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['frontend/app.js'], bundle: true, minify: true, format: 'esm', target: ['es2022'], outfile: 'dist/app.js' });
await build({ entryPoints: ['frontend/admin.js'], bundle: true, minify: true, format: 'esm', target: ['es2022'], outfile: 'dist/admin.js' });
const versions = new Map(await Promise.all(['app.js', 'admin.js', 'styles.css', 'admin.css'].map(async (file) => [file, createHash('sha256').update(await readFile(`dist/${file}`)).digest('hex').slice(0, 12)])));
const adminAssets = { 'admin.js': `admin/client.${versions.get('admin.js')}.js`, 'admin.css': `admin/styles.${versions.get('admin.css')}.css` };
for (const [source, target] of Object.entries(adminAssets)) await cp(`dist/${source}`, `dist/${target}`);
await cp('scripts/connect-account.mjs', 'dist/admin/receiver.mjs');
for (const file of ['index.html', 'admin/index.html']) {
  const html = await readFile(`dist/${file}`, 'utf8');
  await writeFile(`dist/${file}`, html.replace(/(src|href)="\/(app\.js|admin\.js|styles\.css|admin\.css)"/g, (_, attribute, asset) => `${attribute}="/${adminAssets[asset] || `${asset}?v=${versions.get(asset)}`}"`));
}
await writeFile('dist/_routes.json', JSON.stringify({ version: 1, include: ['/api/*', '/admin', '/admin/*'], exclude: [] }));
console.log('Built dist/');
