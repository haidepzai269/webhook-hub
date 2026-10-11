import { HttpException } from '@nestjs/common';
import { SAMPLE_TYPES, canonicalSample, validateCanonical } from '@hub/common';
import { validatePublishBody } from '../../../apps/hub-api/src/modules/service-api/service-api.controller';
import { runCli } from '../src/cli';

/** DX3b (SPEC-dev-experience §4.4): `hub trigger <type>` — mẫu của catalog đi ĐÚNG đường ingest (`POST /events`). */
const KEY = 'hk_test_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const HUB_URL = `hubs://${KEY}@hub.example.com/cafe`;

/** Hub giả: POST /events chạy đúng validatePublishBody của hub-api (validateCanonical cho kiểu dành riêng). */
function fakeHub(scopes = ['publish:events']) {
  const posts: any[] = [];
  const fetch = jest.fn(async (url: string, init: any) => {
    const path = new URL(url).pathname.replace(/^\/v1\/p\/[^/]+/, '');
    let status = 200;
    let body: unknown;
    if (path === '/me') body = { project: { slug: 'cafe', name: 'Cafe', environment: 'test' }, serviceName: 'cafe-svc', scopes };
    else if (path === '/events' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      posts.push(b);
      try {
        validatePublishBody(b);
        status = 202;
        body = { eventId: null, rawEventId: 'raw_1', duplicate: false };
      } catch (e) {
        status = (e as HttpException).getStatus();
        body = { ...((e as HttpException).getResponse() as object), fix: 'sample fix from hub' };
      }
    } else {
      status = 404;
      body = { error: 'not_found' };
    }
    return { status, ok: status < 300, text: async () => JSON.stringify(body) };
  });
  return { fetch, posts };
}

const run = async (argv: string[], hub: ReturnType<typeof fakeHub>) => {
  const lines: string[] = [];
  const code = await runCli(argv, { out: (s) => lines.push(s), err: (s) => lines.push(s), env: { HUB_URL }, fetch: hub.fetch as any });
  return { code, text: lines.join('\n') };
};

describe('[DX] hub trigger (DX3b)', () => {
  it('[DX:UX16] trigger payment.received -> POST /events với mẫu catalog, qua validateCanonical -> 202', async () => {
    const hub = fakeHub();
    const r = await run(['trigger', 'payment.received'], hub);
    expect(r.code).toBe(0);
    expect(hub.posts).toHaveLength(1);
    const b = hub.posts[0];
    expect(b.type).toBe('payment.received');
    expect(validateCanonical(b.type, b.data)).toEqual({ ok: true });
    expect(b.idempotencyKey).toMatch(/^trigger-[0-9a-z]+$/);
    expect(r.text).toContain('Published payment.received');
    expect(r.text).not.toContain(KEY);
  });

  it('--data ghép vào mẫu; amount 1.5 -> hub trả schema_mismatch, CLI in field + fix, mã 1', async () => {
    const hub = fakeHub();
    const ok = await run(['trigger', 'payment.received', '--data', '{"amount":12345}'], hub);
    expect(ok.code).toBe(0);
    expect(hub.posts[0].data.amount).toBe(12345);
    const bad = await run(['trigger', 'payment.received', '--data', '{"amount":1.5}'], hub);
    expect(bad.code).toBe(1);
    expect(bad.text).toMatch(/schema_mismatch/);
    expect(bad.text).toMatch(/amount/);
    expect(bad.text).toContain('fix: sample fix from hub');
  });

  it('hai lần trigger -> idempotencyKey + providerTxnId khác nhau (không bị coi là trùng)', async () => {
    const hub = fakeHub();
    await run(['trigger', 'payment.received'], hub);
    await run(['trigger', 'payment.received'], hub);
    expect(hub.posts[0].idempotencyKey).not.toBe(hub.posts[1].idempotencyKey);
    expect(hub.posts[0].data.providerTxnId).not.toBe(hub.posts[1].data.providerTxnId);
  });

  it('kiểu tự do (order.created) -> data = --data hoặc {}; --data không phải object JSON -> mã 2; thiếu scope -> fix, mã 1', async () => {
    const hub = fakeHub();
    expect((await run(['trigger', 'order.created', '--data', '{"total":1}'], hub)).code).toBe(0);
    expect(hub.posts[0]).toMatchObject({ type: 'order.created', data: { total: 1 } });
    expect((await run(['trigger', 'order.created', '--data', '[1]'], hub)).code).toBe(2);
    expect((await run(['trigger', 'order.created', '--data', '{oops'], hub)).code).toBe(2);
    const noScope = await run(['trigger', 'order.created'], fakeHub(['read:events']));
    expect(noScope.code).toBe(1);
    expect(noScope.text).toMatch(/publish:events/);
  });

  it('mọi mẫu của catalog qua validateCanonical', () => {
    for (const t of SAMPLE_TYPES) expect([t, validateCanonical(t, canonicalSample(t))]).toEqual([t, { ok: true }]);
    expect(canonicalSample('order.created')).toBeNull();
  });
});
