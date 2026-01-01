import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('account requests work in workerd and never forward credentials through redirects', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { outputFiles } = await build({
    stdin: { contents: `
      import { inspectAccount } from './worker/provider.js';
      export default { async fetch() {
        try { return Response.json(await inspectAccount({ dshToken: 'runtime-test-not-a-real-credential' })); }
        catch (error) { return Response.json({ code: error.code, upstreamStatus: error.upstreamStatus }, { status: error.status || 500 }); }
      } };
    `, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const requests = [];
  let redirect = false;
  const options = convertV4MiniflareOptions({
    name: 'provider-runtime-test', modules: true, script: outputFiles[0].text,
    compatibilityDate: '2026-10-01', cf: false,
    outboundService: (request) => {
      requests.push(request.url);
      assert.equal(new URL(request.url).origin, 'https://platform.deepseek.com');
      assert.equal(request.headers.get('x-dsh-auth-token'), 'runtime-test-not-a-real-credential');
      return redirect ? Response.redirect('https://untrusted.invalid/steal', 302)
        : Response.json({ code: 0, data: { biz_code: 0, biz_data: { id: 'runtime-account', currency: 'CNY' } } });
    },
  });
  options.resourceTmpPath = resolve(root, '.local/runtime-tests');
  options.telemetry = { enabled: false };
  await mkdir(options.resourceTmpPath, { recursive: true });
  const runtime = new Miniflare(options);
  try {
    const response = await runtime.dispatchFetch('http://localhost/');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { id: 'runtime-account', currency: 'CNY' });
    redirect = true;
    const rejected = await runtime.dispatchFetch('http://localhost/');
    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), { code: 'UPSTREAM_REDIRECT', upstreamStatus: 302 });
    assert.deepEqual(requests, Array(2).fill('https://platform.deepseek.com/auth-api/v0/users/current'));
  } finally { await runtime.dispose(); }
});
