/**
 * VF5 (SPEC-verification §2 L3, §8.2): chaos trên stack `hubv` — được phép kill/restart/pause container CỦA hubv
 * (luôn qua `docker compose -p hubv`, không bao giờ tên container cứng, không đụng stack dev).
 *
 * Mỗi kịch bản bắn một loạt webhook GitHub (hub-sim, ký độc lập) vào source của một dev mới, phá một thành phần giữa
 * chừng, rồi hành xử như PROVIDER THẬT: request nào không nhận 2xx (lỗi mạng, 5xx) thì gửi lại y hệt tới khi 2xx.
 * Kết luận đo bằng Postgres (trọng tài, BB-2):
 *   0 mất   mọi delivery id đã gửi có ĐÚNG MỘT raw_event ACCEPTED và ĐÚNG MỘT event
 *   0 trùng không id nào có 2 event; mỗi event đúng MỘT delivery cho subscription; mọi delivery SUCCEEDED
 *   BB-3    hub chỉ trả 2xx SAU COMMIT: id nào đã nhận 2xx thì PHẢI có raw_event (kể cả khi tiến trình chết ngay sau)
 *
 * Chạy: `npm run verify:chaos` (~5–8 phút). Không chạy song song với phiên khác đang dùng hubv.
 */
import { spawn } from 'child_process';
import { childEnv, composeBaseArgs, composeOutput, ROOT } from '../lib/compose';
import { closeWorld, createKey, createSource, Dev, psql, registerDev, RUN, sendFixture, SINK_INTERNAL, sleep, Source, svc, uniq } from '../lib/e2e-world';
import { expect } from '../lib/http-session';
import { ScenarioFile, waitFor } from '../lib/scenario';

const w: { dev?: Dev; key: string; gh?: Source } = { key: '' };

/**
 * `docker compose -p hubv …` KHÔNG chặn event loop (spawn, không spawnSync): loạt request phải tiếp tục bay TRONG lúc
 * container bị kill/restart — spawnSync làm loạt request đứng im đúng lúc cần phá.
 */
function dc(args: string[], timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', [...composeBaseArgs(), ...args], { cwd: ROOT, env: childEnv() });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`docker compose ${args.join(' ')} → ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}

async function apiHealthy(timeoutMs = 90_000): Promise<void> {
  await waitFor('hub-api /health 200', async () => (await fetch(`${process.env.VERIFY_API_URL || 'http://localhost:14000'}/health`).catch(() => null))?.ok, timeoutMs, 1000);
}

/** Gửi `ids` như provider: song song `conc`, ghi lại id đã nhận 2xx ở lần đầu. */
async function blast(ids: string[], conc = 8): Promise<{ acked: Set<string>; failed: Set<string> }> {
  const acked = new Set<string>();
  const failed = new Set<string>();
  let i = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (i < ids.length) {
        const id = ids[i++];
        try {
          const r = await sendFixture('github/push', w.gh!.webhookUrl, id);
          (r.status >= 200 && r.status < 300 ? acked : failed).add(id);
        } catch {
          failed.add(id);
        }
      }
    }),
  );
  return { acked, failed };
}

/** Provider gửi lại mọi id chưa 2xx tới khi 2xx (backoff 1 s, tối đa ~2 phút). */
async function redeliver(ids: Iterable<string>): Promise<void> {
  for (const id of ids) {
    await waitFor(`gửi lại ${id} tới khi 2xx`, async () => {
      const r = await sendFixture('github/push', w.gh!.webhookUrl, id).catch(() => null);
      return r && r.status >= 200 && r.status < 300;
    }, 120_000, 1000);
  }
}

/** Bắn liên tục id MỚI trong `ms` mili-giây (để chắc chắn có request đang bay lúc phá). */
async function stream(ms: number, conc = 6): Promise<{ ids: string[]; acked: Set<string>; failed: Set<string> }> {
  const ids: string[] = [];
  const acked = new Set<string>();
  const failed = new Set<string>();
  const until = Date.now() + ms;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (Date.now() < until) {
        const id = uniq();
        ids.push(id);
        try {
          const r = await sendFixture('github/push', w.gh!.webhookUrl, id);
          (r.status >= 200 && r.status < 300 ? acked : failed).add(id);
        } catch {
          failed.add(id);
          await sleep(100); // api chết: lỗi kết nối tức thì — đừng quay vòng nóng
        }
      }
    }),
  );
  return { ids, acked, failed };
}

function newIds(n: number): string[] {
  return Array.from({ length: n }, () => uniq());
}

/** Đếm theo delivery id GitHub (`sim-push-<u>`): raw ACCEPTED, event, delivery/SUCCEEDED cho đúng tập id. */
function ledger(ids: string[]) {
  const list = ids.map((u) => `'sim-push-${u}'`).join(',');
  const row = psql(
    `with r as (select id, headers->>'x-github-delivery' d from hub.raw_events where source_id = '${w.gh!.id}' and status = 'ACCEPTED' and headers->>'x-github-delivery' in (${list})),
          e as (select e.id, r.d from hub.events e join r on r.id = e.raw_event_id)
     select (select count(*) from r), (select count(distinct d) from r), (select count(*) from e), (select count(distinct d) from e),
            (select count(*) from hub.deliveries x join e on e.id = x.event_id),
            (select count(*) from hub.deliveries x join e on e.id = x.event_id where x.status = 'SUCCEEDED'),
            (select count(*) from (select x.event_id from hub.deliveries x join e on e.id = x.event_id group by x.event_id, x.subscription_id having count(*) > 1) z)`,
  );
  const [raw, rawIds, ev, evIds, del, ok, dupDel] = row.split('|').map(Number);
  return { raw, rawIds, ev, evIds, del, ok, dupDel };
}

/** 0 mất / 0 trùng / mọi delivery SUCCEEDED, chờ tối đa `timeoutMs` cho worker xử lý xong. */
async function assertExactlyOnce(ids: string[], acked: Set<string>, label: string, timeoutMs = 120_000): Promise<void> {
  const n = ids.length;
  const final = await waitFor(`${label}: ${n} id → ${n} event, ${n} delivery SUCCEEDED`, async () => {
    const l = ledger(ids);
    return l.ev >= n && l.ok >= n ? l : null;
  }, timeoutMs, 2000).catch(() => ledger(ids));
  // BB-3: mọi id đã nhận 2xx ở lần đầu phải có raw_event — đếm riêng tập acked.
  const ackedList = [...acked];
  const ackedHave = ackedList.length ? ledger(ackedList).rawIds : 0;
  const msg = `${label}: gửi ${n} id (2xx lần đầu ${acked.size}) → raw ${final.raw}/${final.rawIds} id · event ${final.ev}/${final.evIds} id · delivery ${final.ok}/${final.del} SUCCEEDED · trùng delivery ${final.dupDel}`;
  console.log(`  ${msg}`);
  expect(ackedHave === acked.size, `BB-3: ${acked.size - ackedHave} id đã nhận 2xx mà KHÔNG có raw_event (ACK trước COMMIT)`);
  expect(final.raw === n && final.rawIds === n, `mất/trùng ở ingest — ${msg}`);
  expect(final.ev === n && final.evIds === n, `mất/trùng event — ${msg}`);
  expect(final.del === n && final.ok === n && final.dupDel === 0, `delivery thiếu/trùng/chưa SUCCEEDED — ${msg}`);
}

async function setup(): Promise<void> {
  w.dev = await registerDev('l3');
  w.key = await createKey(w.dev, 'l3-svc', ['manage:sources', 'manage:endpoints', 'read:events']);
  w.gh = await createSource(w.key, w.dev.slug, 'github');
  const e = await svc(w.key, w.dev.slug, 'POST', '/endpoints', { name: `sink l3 ${RUN}`, url: `${SINK_INTERNAL}/l3-${RUN}` });
  expect(e.status === 201 && e.body?.verification === 'VERIFIED', `endpoint → ${e.status} ${e.text}`);
  const s = await svc(w.key, w.dev.slug, 'POST', '/subscriptions', { endpointId: e.body.id, name: 'l3', eventTypes: ['repo.*'] });
  expect(s.status === 201, `subscription → ${s.status} ${s.text}`);
}

/** Dù kịch bản đỏ giữa chừng: mọi container hubv phải chạy lại (không để phá kịch bản sau). */
async function heal(): Promise<void> {
  composeOutput(['unpause', 'postgres'], 30_000);
  composeOutput(['start', 'redis', 'rabbitmq', 'hub-api', 'hub-worker'], 120_000);
  await apiHealthy().catch(() => undefined);
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    await heal();
  }
}

const file: ScenarioFile = {
  file: 'verify/scenarios/chaos-l3.ts',
  setup,
  teardown: closeWorld,
  scenarios: [
    {
      name: '[BB:3] (phần l) kill -9 hub-api giữa loạt ingest → id đã nhận 2xx đều có raw_event; provider gửi lại phần lỗi → 0 mất, 0 trùng, delivery SUCCEEDED',
      tags: ['chaos', 'VF5', 'chaos-api'],
      fn: () =>
        guarded(async () => {
          const run = stream(6000, 6);
          await sleep(1000);
          await dc(['kill', '-s', 'SIGKILL', 'hub-api']);
          const { ids, acked, failed } = await run;
          await dc(['start', 'hub-api']);
          await apiHealthy();
          console.log(`  kill hub-api: 2xx ${acked.size}, lỗi ${failed.size} → gửi lại`);
          expect(failed.size > 0, 'kill quá muộn: không request nào lỗi — kịch bản không phá được gì (tăng số id hoặc giảm sleep)');
          await redeliver(failed);
          await assertExactlyOnce(ids, acked, 'kill hub-api');
        }),
    },
    {
      name: 'VF5: kill -9 hub-worker giữa lúc normalize/giao → worker lên lại, xử lý tiếp: 0 mất, 0 trùng event, mỗi event đúng một delivery SUCCEEDED',
      tags: ['chaos', 'VF5', 'chaos-worker'],
      fn: () =>
        guarded(async () => {
          const run = stream(5000, 6);
          await sleep(1500); // worker đang normalize + giao những id đầu
          await dc(['kill', '-s', 'SIGKILL', 'hub-worker']);
          const { ids, acked, failed } = await run;
          console.log(`  kill hub-worker giữa luồng: ${ids.length} id, 2xx ${acked.size}`);
          await redeliver(failed);
          await sleep(3000);
          await dc(['start', 'hub-worker']);
          await assertExactlyOnce(ids, acked, 'kill hub-worker');
        }),
    },
    {
      name: '[AF:#20] (S1-4) restart RabbitMQ giữa loạt → api/worker tự nối lại (AMQP reconnect), outbox đẩy bù: 0 mất, 0 trùng',
      tags: ['chaos', 'VF5', 'chaos-rabbit'],
      fn: () =>
        guarded(async () => {
          const run = stream(8000, 6);
          await sleep(1000);
          await dc(['restart', 'rabbitmq'], 180_000);
          const { ids, acked, failed } = await run;
          console.log(`  restart rabbitmq giữa luồng: ${ids.length} id, 2xx ${acked.size}, lỗi ${failed.size}`);
          await redeliver(failed);
          await assertExactlyOnce(ids, acked, 'restart rabbitmq', 180_000);
        }),
    },
    {
      name: '[BB:2] (phần r) Redis CHẾT: ingest vẫn 2xx; gửi trùng 3 lần mỗi id vẫn đúng một event (Postgres là trọng tài) — chậm chứ không sai',
      tags: ['chaos', 'VF5', 'chaos-redis'],
      fn: () =>
        guarded(async () => {
          await dc(['stop', 'redis']);
          const ids = newIds(20);
          const first = await blast(ids, 4);
          await blast(ids, 4);
          await blast(ids, 4);
          console.log(`  Redis tắt: lượt đầu 2xx ${first.acked.size}/${ids.length}`);
          await redeliver(first.failed);
          await dc(['start', 'redis']);
          await assertExactlyOnce(ids, first.acked, 'redis stop');
        }),
    },
    {
      name: '[BB:2] (phần s) Redis MẤT DỮ LIỆU (FLUSHALL) giữa hai lượt gửi trùng → vẫn đúng một event mỗi id',
      tags: ['chaos', 'VF5', 'chaos-redis'],
      fn: () =>
        guarded(async () => {
          const ids = newIds(20);
          const first = await blast(ids, 4);
          await redeliver(first.failed);
          await dc(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']);
          await blast(ids, 4);
          await assertExactlyOnce(ids, first.acked, 'redis flushall');
        }),
    },
    {
      name: '[BB:3] (phần p) pause Postgres 5 s giữa loạt → không request nào nhận 2xx khi chưa COMMIT; gửi lại phần lỗi → 0 mất, 0 trùng',
      tags: ['chaos', 'VF5', 'chaos-pg'],
      fn: () =>
        guarded(async () => {
          const run = stream(8000, 6);
          await sleep(1000);
          await dc(['pause', 'postgres']);
          const t0 = Date.now();
          await sleep(5000);
          await dc(['unpause', 'postgres']);
          const { ids, acked, failed } = await run;
          console.log(`  pause postgres ${Math.round((Date.now() - t0) / 1000)} s giữa luồng: ${ids.length} id, 2xx ${acked.size}, lỗi ${failed.size}`);
          await redeliver(failed);
          await assertExactlyOnce(ids, acked, 'pause postgres');
        }),
    },
  ],
};

export default file;
