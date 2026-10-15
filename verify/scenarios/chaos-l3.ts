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
import { apiHealthy, assertExactlyOnce as exactlyOnce, blast as blastTo, dc, guarded, newIds, newState, pendingAt as pendingFor, redeliver as redeliverTo, stream as streamTo, StreamState } from '../lib/chaos';
import { closeWorld, createKey, createSource, Dev, registerDev, RUN, SINK_INTERNAL, sleep, Source, svc } from '../lib/e2e-world';
import { expect } from '../lib/http-session';
import { ScenarioFile } from '../lib/scenario';

const w: { dev?: Dev; key: string; gh?: Source } = { key: '' };

// Đồ nghề chung ở verify/lib/chaos.ts (ADR-193, dùng lại cho chaos-bp + LH6) — ở đây chỉ gắn vào source GitHub của file này.
const blast = (ids: string[], conc = 8) => blastTo(w.gh!, ids, conc);
const redeliver = (ids: Iterable<string>) => redeliverTo(w.gh!, ids);
const stream = (ms: number, conc = 6, st: StreamState = newState()) => streamTo(w.gh!, ms, conc, st);
const pendingAt = (st: StreamState, label: string) => pendingFor(w.gh!, st, label);
const assertExactlyOnce = (ids: string[], acked: Set<string>, label: string, timeoutMs = 120_000) => exactlyOnce(w.gh!, ids, acked, label, timeoutMs);

async function setup(): Promise<void> {
  w.dev = await registerDev('l3');
  w.key = await createKey(w.dev, 'l3-svc', ['manage:sources', 'manage:endpoints', 'read:events']);
  w.gh = await createSource(w.key, w.dev.slug, 'github');
  const e = await svc(w.key, w.dev.slug, 'POST', '/endpoints', { name: `sink l3 ${RUN}`, url: `${SINK_INTERNAL}/l3-${RUN}` });
  expect(e.status === 201 && e.body?.verification === 'VERIFIED', `endpoint → ${e.status} ${e.text}`);
  const s = await svc(w.key, w.dev.slug, 'POST', '/subscriptions', { endpointId: e.body.id, name: 'l3', eventTypes: ['repo.*'] });
  expect(s.status === 201, `subscription → ${s.status} ${s.text}`);
}

const file: ScenarioFile = {
  file: 'verify/scenarios/chaos-l3.ts',
  setup,
  teardown: closeWorld,
  scenarios: [
    {
      name: '[BB:3] (phần l) kill -9 hub-api giữa loạt ingest → 0 mất, 0 trùng, delivery SUCCEEDED; id đã nhận 2xx đều có raw_event (chỉ bắt được ACK sớm nếu SIGKILL rơi đúng khe ACK→COMMIT — bằng chứng CHÍNH của BB-3 là L0 + probe P-BB3-01/02)',
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
          const st = newState();
          const run = stream(5000, 6, st);
          await sleep(1500); // worker đang normalize + giao những id đầu
          await dc(['kill', '-s', 'SIGKILL', 'hub-worker']);
          pendingAt(st, 'kill hub-worker'); // worker đã chết: số chưa giao lúc này là việc dở bị cắt ngang
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
          const st = newState();
          const run = stream(8000, 6, st);
          await sleep(1000);
          const restarting = dc(['restart', 'rabbitmq'], 180_000);
          await sleep(2500); // RabbitMQ đang xuống: outbox chưa đẩy được, delivery chưa giao
          pendingAt(st, 'restart rabbitmq');
          await restarting;
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
      name: 'VF5: pause Postgres 5 s giữa luồng → request treo/lỗi, gửi lại phần lỗi → 0 mất, 0 trùng, delivery SUCCEEDED (KHÔNG phải bằng chứng BB-3: pause không giết tiến trình nên ACK sớm vẫn COMMIT sau)',
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
