import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { publicCaptchaKey, renderPaymentChallenge } from '../worker/payment-challenge.js';

test('CAPTCHA configuration comes only from the fixed official public client without account headers', async () => {
  const key = `${'A'.repeat(240)}=_1_1`;
  assert.equal(await publicCaptchaKey(async (url, options) => { assert.equal(url, 'https://fe-static.deepseek.com/platform/static/4099.0741c5b665.js'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined); return new Response(`const key="${key}";`); }), key);
  await assert.rejects(publicCaptchaKey(async () => new Response('private failure', { status: 403 })), { code: 'CAPTCHA_CONFIGURATION_UNAVAILABLE' });
  await assert.rejects(publicCaptchaKey(async () => new Response('no current configuration')), { code: 'CAPTCHA_CONFIGURATION_UNAVAILABLE' });
  await assert.rejects(publicCaptchaKey(async () => new Response(`"${key}" "${'B'.repeat(240)}=_1_1"`)), { code: 'CAPTCHA_CONFIGURATION_UNAVAILABLE' });
});

test('the official CAPTCHA is presented for human action and marks completion only through its SDK callback', async () => {
  const nodes = []; let callbacks;
  const runtime = {
    location: { origin: 'https://platform.deepseek.com' }, setTimeout, clearTimeout,
    window: { AwsWafCaptcha: { renderCaptcha: (_element, config) => { callbacks = config; } } },
    document: { createElement: () => ({ dataset: {}, style: {}, children: [], append(...children) { this.children.push(...children); } }), body: { appendChild: node => { nodes.push(node); } } },
  };
  const page = { evaluate: (fn, argument) => runInNewContext(`(${fn.toString()})(argument)`, { ...runtime, argument }) };
  await renderPaymentChallenge(page, 'public-domain-configuration');
  assert.equal(nodes[0].dataset.complete, 'false'); assert.equal(callbacks.defaultLocale, 'zh-CN');
  callbacks.onSuccess('private-proof-not-to-export');
  assert.equal(nodes[0].dataset.complete, 'true'); assert.ok(!JSON.stringify(nodes).includes('private-proof-not-to-export'));
  runtime.location.origin = 'https://other.example';
  await assert.rejects(renderPaymentChallenge(page, 'public-domain-configuration'), { code: 'PAYMENT_CHALLENGE_UNAVAILABLE' });
  assert.equal(nodes.length, 1);
});
