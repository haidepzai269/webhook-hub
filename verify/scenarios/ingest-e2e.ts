/**
 * VF4 (SPEC-verification §2 L2, §5.5): luồng THẬT từ đầu tới cuối qua HTTP, thay `scripts/e2e-smoke.sh`.
 * Một dev mới (đăng ký + xác minh mail) tạo key, 5 source (PayOS, SePay, Stripe, GitHub, AB Bank generic) với secret
 * GIẢ của .env.verify, một endpoint trỏ sink; hub-sim (ký độc lập) bắn 14 fixture §5.4 → kiểm status, kiểu chuẩn qua
 * polling, chống trùng, push ký Standard Webhooks (verify bằng hub-sim, không bằng code hub), outbox sạch secret.
 *
 * Chạy: `npm run verify:e2e` (mọi tag) · `npm run verify:e2e -- --tag smoke`.
 */
import { listFixtures, loadFixture } from '../../tools/hub-sim/src/fixture';
import { swVerify } from '../../tools/hub-sim/src/sign';
import { API, closeWorld, flushIdempotencyKeys, createKey, createSource, Dev, psql, registerDev, RUN, sendFixture, SINK, SINK_INTERNAL, sleep, Source, svc, uniq } from '../lib/e2e-world';
import { composeOutput } from '../lib/compose';
import { expect } from '../lib/http-session';
import { ScenarioFile, waitFor } from '../lib/scenario';

const DEPLOYED = process.env.VERIFY_DEPLOYED === '1';

const w: {
  dev?: Dev;
  key: string;
  slug: string;
  sources: Record<string, Source>;
  endpoint?: { id: string; signingSecret: string; path: string };
  /** fixture id -> unique đã dùng ở kịch bản "14 fixture" */
  sent: Record<string, string>;
} = { key: '', slug: '', sources: {}, sent: {} };

async function poll(after = '0'): Promise<any[]> {
  const out: any[] = [];
  let cursor = after;
  for (let i = 0; i < 50; i++) {
    const r = await svc(w.key, w.slug, 'GET', `/events?after=${cursor}&limit=100`);
    expect(r.status === 200, `poll → ${r.status} ${r.text}`);
    out.push(...r.body.events);
    if (r.body.events.length < 100) break;
    cursor = r.body.nextCursor;
  }
  return out;
}

async function setup(): Promise<void> {
  if (DEPLOYED) {
    // verify:deployed (VF8): KHÔNG đăng ký, KHÔNG tạo source — chỉ project `demo` có sẵn + key do Admin cấp.
    w.key = process.env.VERIFY_API_KEY ?? '';
    w.slug = process.env.VERIFY_PROJECT_SLUG ?? 'demo';
    expect(w.key, 'verify:deployed cần VERIFY_API_KEY (scope publish:events + read:events của project demo)');
    return;
  }
  w.dev = await registerDev('l2');
  w.slug = w.dev.slug;
  w.key = await createKey(w.dev, 'l2-svc', ['manage:sources', 'manage:endpoints', 'read:events', 'publish:events']);
  for (const p of ['payos', 'sepay', 'stripe', 'github'] as const) w.sources[p] = await createSource(w.key, w.slug, p);
  w.sources.generic = await createSource(w.key, w.slug, 'generic', loadFixture('generic/x-signature-ok').sourceConfig);
  // Endpoint của "service" = sink (đầu nhận độc lập hub). Challenge thật; secret do hub sinh, trả đúng một lần.
  const path = `/l2-${RUN}`;
  const e = await svc(w.key, w.slug, 'POST', '/endpoints', { name: `sink ${RUN}`, url: `${SINK_INTERNAL}${path}` });
  expect(e.status === 201 && e.body?.verification === 'VERIFIED' && e.body?.signingSecret, `tạo endpoint → ${e.status} ${e.text}`);
  w.endpoint = { id: e.body.id, signingSecret: e.body.signingSecret, path };
  const sub = await svc(w.key, w.slug, 'POST', '/subscriptions', { endpointId: e.body.id, name: 'l2 all', eventTypes: ['payment.*', 'repo.*'] });
  expect(sub.status === 201, `tạo subscription → ${sub.status} ${sub.text}`);
}

const file: ScenarioFile = {
  file: 'verify/scenarios/ingest-e2e.ts',
  setup,
  teardown: closeWorld,
  scenarios: [
    {
      name: 'VF4: 14 fixture hub-sim (ký độc lập) qua HTTP vào source của dev mới → đúng 200/401 từng ca; 200 thì event đúng kiểu chuẩn hiện ở polling, 401 thì không có event',
      tags: ['smoke', 'VF3', 'VF4'],
      fn: async () => {
        const bad: string[] = [];
        const want: string[] = [];
        for (const id of listFixtures()) {
          const f = loadFixture(id);
          const u = uniq();
          w.sent[id] = u;
          const r = await sendFixture(id, w.sources[f.provider].webhookUrl, u);
          if (r.status !== f.expect.status) bad.push(`${id}: ${r.status} (mong ${f.expect.status}) ${r.text.slice(0, 120)}`);
          // Probe của provider (ADR-159) không bao giờ hiện ở polling — kiểm riêng ở kịch bản [KN:U16] (phần o).
          if (f.expect.status === 200 && f.expect.type && !f.expect.probe) want.push(`${w.sources[f.provider].id}|${f.expect.type}|${f.expect.normalized}`);
        }
        expect(bad.length === 0, `sai status:\n    ${bad.join('\n    ')}`);
        const got = await waitFor('đủ event của 14 fixture ở polling', async () => {
          const evs = await poll();
          const have = evs.map((e) => `${e.sourceId}|${e.type}|${e.normalized}`);
          return want.every((x) => have.includes(x)) ? have : null;
        });
        expect(got.length === want.length, `polling có ${got.length} event, mong ĐÚNG ${want.length} (ca 401 không được sinh event):\n    ${got.sort().join('\n    ')}`);
        console.log(`  ${listFixtures().length} fixture → ${want.length} event: ${[...new Set(want.map((x) => x.split('|')[1]))].join(', ')}`);
      },
    },
    {
      name: '[VF:VT6] (phần b) Stripe t cũ (hub-sim không ký lại thời gian) → 401 qua HTTP, không event; cùng body ký t = now → 200',
      tags: ['smoke', 'VF3', 'VF4'],
      fn: async () => {
        const u = uniq();
        const old = await sendFixture('stripe/stale-timestamp', w.sources.stripe.webhookUrl, u);
        expect(old.status === 401, `t cũ → ${old.status} ${old.text}`);
        const fresh = await sendFixture('stripe/pi-succeeded', w.sources.stripe.webhookUrl, u); // cùng body (cùng __U__), t = now
        expect(fresh.status === 200, `t mới → ${fresh.status} ${fresh.text}`);
      },
    },
    {
      name: '[BB:2] (phần l) gửi lại y hệt 3 lần (SePay, GitHub), XOÁ khoá idem:* của Redis giữa các lần (chỉ Postgres phán) → 200 cả 3, đúng MỘT event mỗi loại',
      tags: ['smoke', 'VF4', 'demo-redeliver'],
      fn: async () => {
        // Nhận diện lần gửi: GitHub theo header delivery, SePay theo `id` trong body (cả hai chứa số unique `u`).
        const cases = [
          { id: 'sepay/money-in', provider: 'sepay', match: (u: string) => `convert_from(r.body_raw,'UTF8') like '%"id": 9270${u},%'` },
          { id: 'github/push', provider: 'github', match: (u: string) => `r.headers->>'x-github-delivery' = 'sim-push-${u}'` },
        ] as const;
        for (const c of cases) {
          const u = uniq();
          for (let i = 0; i < 3; i++) {
            if (i > 0) {
              // M-6: lần 2, 3 không được nhờ đường tắt Redis. L-R2-4: lần 1 đã 200 => SET NX (sau COMMIT) đã ghi khoá
              // idem:* — trước lần 2 xoá 0 khoá nghĩa là đang trỏ nhầm Redis và "Redis trống" là suông. (Bản trùng do PG
              // phán KHÔNG ghi lại khoá, nên trước lần 3 có thể là 0.)
              const flushed = await flushIdempotencyKeys();
              if (i === 1) expect(flushed >= 1, `${c.id} lần 2: xoá ${flushed} khoá idem:* (mong >= 1 — VERIFY_REDIS_URL có phải Redis của hubv?)`);
            }
            const r = await sendFixture(c.id, w.sources[c.provider].webhookUrl, u);
            expect(r.status === 200, `${c.id} lần ${i + 1} → ${r.status} ${r.text}`);
          }
          await sleep(1500); // normalize chạy ở worker, sau COMMIT
          const where = `r.source_id = '${w.sources[c.provider].id}' and ${c.match(u)}`;
          const [raw, ev] = psql(`select (select count(*) from hub.raw_events r where ${where}), (select count(*) from hub.events e join hub.raw_events r on r.id = e.raw_event_id where ${where})`).split('|');
          expect(raw === '1' && ev === '1', `${c.id} gửi 3 lần → ${raw} raw_events / ${ev} event (mong 1/1)`);
        }
      },
    },
    {
      name: 'VF4: push tới endpoint của dev — mọi request tới sink mang Standard Webhooks hợp lệ khi verify ĐỘC LẬP bằng hub-sim (secret hub trả lúc tạo endpoint); delivery tới SUCCEEDED',
      tags: ['smoke', 'VF4', 'MS:S6'],
      fn: async () => {
        expect(w.endpoint, 'chưa có endpoint (setup)');
        const reqs = await waitFor('sink nhận push của các event payment.*/repo.*', async () => {
          const r = (await (await fetch(`${SINK}/_requests?path=${encodeURIComponent(w.endpoint!.path)}`)).json()) as any[];
          const pushes = r.filter((x) => x.headers['webhook-id'] && !String(x.headers['webhook-id']).startsWith('verify_'));
          return pushes.length >= 6 ? pushes : null;
        }, 30_000, 500);
        const nowS = Math.floor(Date.now() / 1000);
        const invalid = reqs.filter((x) => !swVerify(w.endpoint!.signingSecret, x.headers, Buffer.from(x.body, 'utf8'), nowS, 600));
        expect(invalid.length === 0, `${invalid.length}/${reqs.length} push KHÔNG verify được bằng hub-sim (webhook-id ${invalid.map((x) => x.headers['webhook-id']).join(', ')})`);
        const st = await waitFor('mọi delivery của project tới trạng thái cuối', async () => {
          const row = psql(`select count(*), count(*) filter (where status = 'SUCCEEDED'), count(*) filter (where status in ('SUCCEEDED','DEAD')) from hub.deliveries where tenant_id = '${w.dev!.projectId}'`);
          const [all, ok, done] = row.split('|').map(Number);
          return all > 0 && all === done ? { all, ok } : null;
        }, 30_000, 500);
        expect(st.all === st.ok, `${st.all - st.ok}/${st.all} delivery không SUCCEEDED`);
        console.log(`  ${reqs.length} push verify độc lập OK · ${st.ok}/${st.all} delivery SUCCEEDED`);
      },
    },
    {
      name: '[AF:#39] (S1-8, thay scripts/e2e-smoke.sh) hub.outbox không chứa chuỗi giống secret (signingSecret, botToken, webhookUrl, config); cùng các kịch bản smoke ở trên: ký đúng 200 · ký sai 401 · gửi lại → 1 event · delivery SUCCEEDED',
      tags: ['smoke', 'VF4'],
      fn: async () => {
        const n = psql(`select count(*) from hub.outbox where payload::text ~* 'signingSecret|botToken|webhookUrl|"config"' or strpos(payload::text, '${w.endpoint!.signingSecret}') > 0`);
        expect(n === '0', `hub.outbox còn ${n} dòng chứa secret/config`);
      },
    },
    {
      name: '[AF:#35] (S1-5) Shop dùng role riêng: psql -U shop_user đọc hub.events → permission denied for schema hub; shop.orders đọc được',
      tags: ['smoke', 'VF4'],
      fn: async () => {
        const run = (sql: string) => composeOutput(['exec', '-T', 'postgres', 'psql', '-U', 'shop_user', '-d', 'webhook_hub', '-tA', '-c', sql]);
        const hub = run('select count(*) from hub.events');
        expect(hub.status !== 0 && /permission denied for schema hub/.test(hub.stderr), `shop_user đọc hub.events → exit ${hub.status} ${hub.stdout}${hub.stderr}`);
        const shop = run('select count(*) from shop.orders');
        expect(shop.status === 0 && /^\d+$/.test(shop.stdout.trim()), `shop_user đọc shop.orders → exit ${shop.status} ${shop.stderr}`);
      },
    },
    {
      name: 'VF4: publish bằng API key → event đọc lại được qua polling theo cursor (publish:events + read:events)',
      tags: ['smoke', 'VF4', '@deployed-safe'],
      fn: async () => {
        const before = await svc(w.key, w.slug, 'GET', '/events?after=latest');
        const after = before.status === 200 && before.body?.nextCursor ? before.body.nextCursor : '0';
        const type = `e2e.ping_${RUN}`;
        const p = await svc(w.key, w.slug, 'POST', '/events', { type, idempotencyKey: `l2-${RUN}-${uniq()}`, data: { ok: true } });
        expect(p.status === 202, `publish → ${p.status} ${p.text}`);
        await waitFor(`event ${type} ở polling`, async () => (await poll(after)).some((e) => e.type === type));
        console.log(`  ${API}: publish → poll OK`);
      },
    },
    {
      name: '[KN:U16] (phần o) PayOS confirm probe (hub-sim, bộ mẫu tài liệu) qua HTTP, image thật: 200 hai lần (lần 2 duplicate), 1 raw + 1 event payos.webhook_test probe=true, 0 delivery dù subscription `*` đang bật, vắng ở polling',
      tags: ['VF4', 'KN3'],
      fn: async () => {
        // Source + subscription RIÊNG (sourceIds chỉ source này): probe phải đi qua normalize khi `*` đã bật, và không
        // làm lệch số delivery của các kịch bản khác.
        expect(w.endpoint, 'chưa có endpoint (setup)');
        const src = await createSource(w.key, w.slug, 'payos');
        const sub = await svc(w.key, w.slug, 'POST', '/subscriptions', { endpointId: w.endpoint!.id, name: `probe-all ${RUN}`, eventTypes: ['*'], sourceIds: [src.id] });
        expect(sub.status === 201, `tạo subscription * → ${sub.status} ${sub.text}`);
        const before = await svc(w.key, w.slug, 'GET', '/events?after=latest');
        const after = before.status === 200 && before.body?.nextCursor ? before.body.nextCursor : '0';
        for (let i = 0; i < 2; i++) {
          const r = await sendFixture('payos/confirm-probe', src.webhookUrl, '0');
          expect(r.status === 200, `probe lần ${i + 1} → ${r.status} ${r.text} (PayOS coi khác 2xx là xác nhận thất bại)`);
        }
        const ev = await waitFor('event probe đã normalize', async () => {
          const row = psql(
            `select count(*), count(*) filter (where e.probe), string_agg(distinct e.type, ','), (select count(*) from hub.raw_events r where r.source_id = '${src.id}')
               from hub.events e where e.source_id = '${src.id}'`,
          );
          const [n, probes, types, raws] = row.split('|');
          return n === '1' ? { probes, types, raws } : null;
        });
        expect(ev.raws === '1', `raw_events của source probe = ${ev.raws} (mong 1: lần 2 là duplicate)`);
        expect(ev.probes === '1' && ev.types === 'payos.webhook_test', `event probe: probe=${ev.probes} type=${ev.types}`);
        await sleep(1500); // nếu lõi lỡ định tuyến, delivery tạo cùng transaction normalize — chờ thêm cho chắc
        const dl = psql(`select count(*) from hub.deliveries d join hub.events e on e.id = d.event_id where e.source_id = '${src.id}'`);
        expect(dl === '0', `probe sinh ${dl} delivery (mong 0 dù subscription * đang bật)`);
        const evs = await poll(after);
        const leaked = evs.filter((e) => e.sourceId === src.id || e.type === 'payos.webhook_test');
        expect(leaked.length === 0, `polling lộ ${leaked.length} event probe`);
        console.log('  probe: 200×2 · 1 raw · 1 event payos.webhook_test probe=true · 0 delivery · vắng ở polling');
      },
    },
  ],
};

export default file;
