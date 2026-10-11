/**
 * VF8 (SPEC-verification §9.2): dữ liệu nền cho buổi tập dượt LOCAL (hubv vừa reset) — một dev "demo" đăng ký qua
 * mail capture, key, source GitHub (secret giả .env.verify), endpoint trỏ sink, rồi 200 event (publish + webhook
 * hub-sim) để dashboard không trống. In thông tin đăng nhập console để người trình bày dùng.
 * Chỉ chạy vào hubv (localhost). KHÔNG import code hub.
 */
import { closeWorld, createKey, createSource, PASSWORD, registerDev, RUN, sendFixture, SINK_INTERNAL, svc, uniq } from '../lib/e2e-world';
import { expect } from '../lib/http-session';

async function main() {
  const dev = await registerDev('demo');
  const key = await createKey(dev, 'demo-shop', ['manage:sources', 'manage:endpoints', 'read:events', 'publish:events']);
  const gh = await createSource(key, dev.slug, 'github');
  const e = await svc(key, dev.slug, 'POST', '/endpoints', { name: 'sink demo', url: `${SINK_INTERNAL}/demo-${RUN}` });
  expect(e.status === 201, `endpoint → ${e.status} ${e.text}`);
  const sub = await svc(key, dev.slug, 'POST', '/subscriptions', { endpointId: e.body.id, name: 'demo', eventTypes: ['repo.*', 'order.*'] });
  expect(sub.status === 201, `subscription → ${sub.status} ${sub.text}`);
  let ok = 0;
  for (let i = 0; i < 100; i++) {
    const r = await sendFixture('github/push', gh.webhookUrl, uniq());
    if (r.status === 200) ok += 1;
    const p = await svc(key, dev.slug, 'POST', '/events', { type: 'order.created', idempotencyKey: `demo-${RUN}-${i}`, data: { n: i } });
    if (p.status === 202) ok += 1;
  }
  console.log(`\n✓ demo nền: ${ok}/200 event vào project ${dev.slug}`);
  console.log(`  Console hubv: http://localhost:13000  ·  đăng nhập ${dev.email} / ${PASSWORD}`);
  console.log(`  Key (chỉ hubv, giá trị test): ${key.slice(0, 12)}…  ·  source GitHub: ${gh.webhookUrl}`);
  await closeWorld();
  process.exit(ok === 200 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`✗ ${(e as Error).message}`);
  await closeWorld();
  process.exit(1);
});
