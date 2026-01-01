// Cloudflare Pages -> private Worker service binding. The request URL is preserved.
export async function onRequest({ request, env }) {
  if (!env.PAYMENT_API) return Response.json({ error: { code: 'NOT_CONFIGURED', message: '暂时无法连接，请稍后再试。' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return env.PAYMENT_API.fetch(request);
}
