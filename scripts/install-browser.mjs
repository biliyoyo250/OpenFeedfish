import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
// Keep all browser artifacts inside this checkout, on either Windows or Linux.
const child = spawn(process.execPath, [join(root, 'node_modules/playwright/cli.js'), 'install', '--no-shell', ...(process.argv.includes('--with-deps') ? ['--with-deps'] : []), 'chromium'], { cwd: root, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(root, '.local/playwright') }, windowsHide: true });
child.on('exit', (code) => { process.exitCode = code || 0; });
child.on('error', () => { console.error('浏览器安装未启动，请先 npm ci。'); process.exitCode = 1; });
