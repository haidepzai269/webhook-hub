/**
 * BP chaos LOCAL (SPEC-ap-luc-nguoc §13 [BP:T4] [BP:T16] [BP:T21] phần b, C8; ADR-193) — số liệu THẬT trên stack `hubv`.
 * Phần a (mô phỏng L0/L1) ở apps/hub-worker/test/backpressure.spec.ts và circuit-breaker.spec.ts.
 *
 *   [BP:T4]  giết Postgres 60 s DƯỚI TẢI (cả lane normalize lẫn delivery có hàng) -> số lần xử lý message chạm DB mỗi 5 s bị
 *            chặn trên (chế độ dò ≤ 2 / 5 s trên đường consumer (normalize + delivery), ≤ 1 / lane), log consumer không xả; DB về -> 0 mất, 0 trùng.
 *   [BP:T21] dừng Postgres 10 phút dưới tải đều -> q.normalize.dlq tăng ≤ 5; DB về thì xử lý hết (0 mất, 0 trùng).
 *   [BP:T16] đích chết 10 phút với 500 delivery hoãn -> hồi phục: không giây nào vượt trần ramp (2,4,…,64 rps trong 60 s).
 *
 * KHÔNG nằm trong `npm run verify:chaos` (tag `chaos`, nightly ~45 phút) — tổng ~35–40 phút, chạy tay:
 *   npm run verify:chaos:bp                       cả ba
 *   npm run verify:chaos -- --tag bp-t4           một kịch bản (bp-t4 | bp-t21 | bp-t16)
 * Thời lượng rút ngắn để thử nhanh (KHÔNG dùng cho số liệu báo cáo): BP_T4_DOWN_MS, BP_T21_DOWN_MS, BP_T16_DOWN_MS.
 * Kết quả chi tiết (chuỗi mẫu, cửa sổ, log): verify/.results/chaos-bp-T*.json. Không chạy song song phiên khác dùng hubv (C8).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  assertExactlyOnce,
  blast,
  ChaosSource,
  closeChaosAmqp,
  closeChaosRedis,
  guarded,
  holdDown,
  hubvRedis,
  ledger,
  logRate,
  MetricsSampler,
  newIds,
  paced,
  preloadBacklog,
  queueCountsExact,
  redeliver,
  restartCount,
  sinkMode,
  sinkRequests,
  sinkReset,
  workerLogs,
} from '../lib/chaos';
import { ROOT } from '../lib/compose';
// Hằng ramp: một nguồn với worker (import thẳng file nguồn — @hub/messaging trỏ dist, verify không build lib).
import { DELIVERY_RAMP_SECONDS, DELIVERY_RAMP_START_RPS, DELIVERY_RAMP_STEP_SECONDS, deliveryRampConfig, deliveryRampLastStep } from '../../libs/messaging/src/retry-window';
import { closeWorld, createKey, createSource, registerDev, RUN, SINK_INTERNAL, sleep, svc } from '../lib/e2e-world';
import { expect } from '../lib/http-session';
import { ScenarioFile, waitFor } from '../lib/scenario';

const envMs = (k: string, d: number) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
const RESULTS = path.join(ROOT, 'verify', '.results');

/** Mỗi kịch bản một dev/project riêng (subscription `repo.*` của project không lẫn sang đích của kịch bản khác). */
async function world(tag: string): Promise<{ src: ChaosSource; endpointId: string; sinkPath: string }> {
  const dev = await registerDev(tag);
  const key = await createKey(dev, `${tag}-svc`, ['manage:sources', 'manage:endpoints', 'read:events']);
  const src = await createSource(key, dev.slug, 'github');
  const sinkPath = `/${tag}-${RUN}`;
  const e = await svc(key, dev.slug, 'POST', '/endpoints', { name: `sink ${tag} ${RUN}`, url: `${SINK_INTERNAL}${sinkPath}` });
  expect(e.status === 201 && e.body?.verification === 'VERIFIED', `endpoint → ${e.status} ${e.text}`);
  const s = await svc(key, dev.slug, 'POST', '/subscriptions', { endpointId: e.body.id, name: tag, eventTypes: ['repo.*'] });
  expect(s.status === 201, `subscription → ${s.status} ${s.text}`);
  return { src, endpointId: e.body.id, sinkPath };
}

/** Bảng tiêu chí: ghi hết rồi mới đỏ (để file kết quả có đủ số kể cả khi một tiêu chí trượt). */
class Verdicts {
  readonly rows: { criterion: string; measured: string; pass: boolean }[] = [];
  check(criterion: string, measured: string, pass: boolean): void {
    this.rows.push({ criterion, measured, pass });
    console.log(`  ${pass ? 'PASS' : 'FAIL'} · ${criterion} — ${measured}`);
  }
  async soft(criterion: string, fn: () => Promise<string>): Promise<void> {
    try {
      this.check(criterion, await fn(), true);
    } catch (e) {
      this.check(criterion, (e as Error).message.slice(0, 400), false);
    }
  }
  finish(file: string, data: Record<string, unknown>): void {
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, file), JSON.stringify({ at: new Date().toISOString(), verdicts: this.rows, ...data }, null, 2));
    console.log(`  chi tiết: verify/.results/${file}`);
    const bad = this.rows.filter((r) => !r.pass);
    expect(bad.length === 0, `${bad.length} tiêu chí trượt: ${bad.map((b) => b.criterion).join(' · ')}`);
  }
}

// Bộ đếm "một lần xử lý message đã chạm DB" theo lane (DB chết -> mỗi lần = một lần gọi Prisma thất bại).
const DELIVERY_DB = [{ name: 'hub_delivery_infra_errors_total' }];
const NORMALIZE_DB = [{ name: 'hub_normalize_deferred_total' }, { name: 'hub_normalize_retries_total' }];
/**
 * Bộ đếm tăng lúc lần gọi THẤT BẠI, không phải lúc bắt đầu. Postgres bị giết thì kết nối mới treo tới `connect_timeout` của
 * Prisma (mặc định 5 s, DATABASE_URL hubv không đặt) -> permit cấp NGAY TRƯỚC khi factor lên 1 có thể báo lỗi tới 5 s sau.
 * Cửa sổ "chế độ dò ổn định" vì thế bắt đầu 6 s sau mẫu đầu tiên có factor = 1 (5 s + 1 nhịp lấy mẫu); số thô từ chính
 * mốc factor = 1 vẫn ghi vào kết quả.
 */
const PRISMA_CONNECT_TIMEOUT_MS = 5_000;
const FACTOR = (s: MetricsSampler, i: number) => MetricsSampler.value(s.samples[i], 'hub_backpressure_factor', { dependency: 'db' });

/**
 * Mỗi cửa sổ [mẫu i, mẫu j] dài ≤ 5 s trong [from, to): max số lần chạm DB của `lanes` (mặc định cả hai lane — chế độ dò ≤ 2;
 * một lane — ≤ 1). Sai số mẫu 1 s: cửa sổ đo là khoảng giữa hai mẫu (≤ 5 s), không phải mọi khoảng 5 s liên tục.
 */
function maxPer5s(s: MetricsSampler, from: number, to: number, lanes = [...DELIVERY_DB, ...NORMALIZE_DB]): { max: number; at: number; windows: number } {
  let max = 0;
  let at = 0;
  let windows = 0;
  for (let i = from; i < to; i++) {
    for (let j = i + 1; j <= to && s.samples[j].t - s.samples[i].t <= 5000; j++) {
      windows++;
      const d = s.delta(i, j, lanes);
      if (d > max) {
        max = d;
        at = s.samples[i].t;
      }
    }
  }
  return { max, at, windows };
}

function perSampleSeries(s: MetricsSampler, from: number, to: number, t0: number) {
  const out: { s: number; delivery: number; normalize: number; factor: number; heldN: number; heldD: number }[] = [];
  for (let i = Math.max(1, from); i <= to; i++) {
    out.push({
      s: Math.round((s.samples[i].t - t0) / 100) / 10,
      delivery: s.delta(i - 1, i, DELIVERY_DB),
      normalize: s.delta(i - 1, i, NORMALIZE_DB),
      factor: FACTOR(s, i),
      heldN: MetricsSampler.value(s.samples[i], 'hub_backpressure_held', { consumer: 'normalize' }),
      heldD: MetricsSampler.value(s.samples[i], 'hub_backpressure_held', { consumer: 'delivery' }),
    });
  }
  return out;
}

const file: ScenarioFile = {
  file: 'verify/scenarios/chaos-bp.ts',
  teardown: async () => {
    await closeChaosRedis();
    await closeChaosAmqp();
    await closeWorld();
  },
  scenarios: [
    {
      name: '[BP:T4] (phần b) LOCAL hubv: giết Postgres 60 s dưới tải (normalize + delivery) — chế độ dò ≤ 2 lần chạm DB / 5 s trên đường consumer (normalize + delivery), log consumer gộp, DB về 0 mất 0 trùng',
      tags: ['chaos-bp', 'bp-t4', 'BP5'],
      fn: () =>
        guarded(async () => {
          const DOWN = envMs('BP_T4_DOWN_MS', 60_000);
          const N = envMs('BP_T4_N', 2000);
          const v = new Verdicts();
          const w = await world('bp4');
          await sinkReset();
          await sinkMode(w.sinkPath, { delayMs: 1000 }); // đích chậm 1 s: 20 prefetch -> ≤ 20 delivery/s, q.delivery.main dồn
          const q0 = await queueCountsExact();
          const sampler = new MetricsSampler();
          const pre = await preloadBacklog(w.src, {
            n: N,
            ready: (d) => (d['q.normalize']?.total ?? 0) >= 100 && (d['q.delivery.main']?.total ?? 0) >= 100,
            timeoutMs: 60_000,
            onStarted: () => sampler.start(),
          });
          const r0 = await restartCount('hub-worker');
          console.log(`  tải trước khi phá: ${N} id (2xx ${pre.st.acked.size}); queue READY lúc đủ điều kiện ${JSON.stringify(pre.depths)}; ready=${pre.readyMet}`);
          const win = await holdDown('kill', DOWN);
          console.log(`  Postgres SIGKILL ${Math.round((win.startedAt - win.downAt) / 1000)} s, nhận kết nối lại sau ${Math.round((win.readyAt - win.startedAt) / 1000)} s`);
          let drain: { waitedMs: number } | null = null;
          await v.soft('DB về: 0 mất / 0 trùng / mọi delivery SUCCEEDED (BB-3: id đã 2xx đều có raw)', async () => {
            drain = await assertExactlyOnce(w.src, pre.st.ids, pre.st.acked, 'T4', 300_000);
            return `${N}/${N} event + delivery SUCCEEDED sau ${Math.round(drain.waitedMs / 1000)} s kể từ DB nhận kết nối`;
          });
          await sleep(2000);
          sampler.stop();
          const r1 = await restartCount('hub-worker');
          const q1 = await queueCountsExact();

          const iDown = Math.max(0, sampler.indexAt(win.downAt) - 1); // mẫu cuối TRƯỚC lúc phá
          const iUp = sampler.indexAt(win.startedAt) - 1;
          const delivCalls = sampler.delta(iDown, iUp, DELIVERY_DB);
          const normCalls = sampler.delta(iDown, iUp, NORMALIZE_DB);
          const iProbe = (() => {
            for (let i = iDown; i <= iUp; i++) if (FACTOR(sampler, i) >= 1) return i;
            return -1;
          })();
          const toProbeMs = iProbe >= 0 ? sampler.samples[iProbe].t - win.downAt : -1;
          const series = perSampleSeries(sampler, iDown, sampler.samples.length - 1, win.downAt);
          const firstSecs = series.filter((x) => x.s <= toProbeMs / 1000);
          const w5raw = iProbe >= 0 ? maxPer5s(sampler, iProbe, iUp) : { max: -1, at: 0, windows: 0 };
          const iSteady = iProbe >= 0 ? sampler.indexAt(sampler.samples[iProbe].t + PRISMA_CONNECT_TIMEOUT_MS + 1000) : -1;
          const w5 = iSteady >= 0 && iSteady < iUp ? maxPer5s(sampler, iSteady, iUp) : { max: -1, at: 0, windows: 0 };
          const NONE = { max: -1, at: 0, windows: 0 };
          const w5d = iSteady >= 0 && iSteady < iUp ? maxPer5s(sampler, iSteady, iUp, DELIVERY_DB) : NONE;
          const w5n = iSteady >= 0 && iSteady < iUp ? maxPer5s(sampler, iSteady, iUp, NORMALIZE_DB) : NONE;
          const probeCalls = iSteady >= 0 ? sampler.delta(iSteady, iUp, [...DELIVERY_DB, ...NORMALIZE_DB]) : -1;
          const probeSpanS = iSteady >= 0 ? (sampler.samples[iUp].t - sampler.samples[iSteady].t) / 1000 : 0;
          const inflightBurst = iProbe >= 0 && iSteady > iProbe ? sampler.delta(iProbe, iSteady, [...DELIVERY_DB, ...NORMALIZE_DB]) : 0;
          const infraKinds = {
            transient: sampler.delta(iDown, iUp, [{ name: 'hub_delivery_infra_errors_total', labels: { kind: 'transient' } }]),
            unknown: sampler.delta(iDown, iUp, [{ name: 'hub_delivery_infra_errors_total', labels: { kind: 'unknown' } }]),
          };
          const spilled = sampler.delta(iDown, sampler.samples.length - 1, [{ name: 'hub_backpressure_spilled_total' }]);
          const iZero = (() => {
            for (let i = iUp + 1; i < sampler.samples.length; i++) if (FACTOR(sampler, i) === 0) return i;
            return -1;
          })();

          // Review Thấp (5): khung log từ lúc phá tới khi factor về 0 (gồm cả pha hồi phục), không dừng ở lúc DB lên lại.
          const logUntil = iZero >= 0 ? sampler.samples[iZero].t : win.readyAt;
          const logs = await workerLogs(win.downAt, logUntil);
          const rate = logRate(logs);
          const deliveryWarn = logs.filter((l) => l.level === 'warn' && l.msg.startsWith('Lỗi hạ tầng hub ở delivery')).length;
          const tProbe = iProbe >= 0 ? sampler.samples[iProbe].t : Infinity;
          const normWarnAfterProbe = logs.filter((l) => l.level === 'warn' && l.msg.startsWith('Lỗi tạm ở normalize') && l.t >= tProbe).length;
          const consumerLines = logs.filter((l) => ['warn', 'error'].includes(l.level) && /normalize|delivery/i.test(l.msg) && !/Outbox|sweeper|Alert/i.test(l.msg));
          const consumerRate = logRate(consumerLines);
          const relayLines = logs.filter((l) => l.msg === 'Lỗi trong chu kỳ Outbox Relay').length;
          const sinkReqs = await sinkRequests(w.sinkPath);
          const byId = new Map<string, number>();
          for (const r of sinkReqs) if (r.headers['webhook-id']) byId.set(r.headers['webhook-id'], (byId.get(r.headers['webhook-id']) ?? 0) + 1);
          const sinkDup = [...byId.values()].filter((n) => n > 1).length;

          v.check('Tiền đề: Postgres chết THẬT suốt cửa sổ (kiểm mỗi 5 s)', `${win.unexpectedlyUp} lần thấy đang chạy`, win.unexpectedlyUp === 0);
          v.check('Tiền đề: CẢ HAI lane có message chạm DB trong lúc DB chết (phá dưới tải)', `delivery ${delivCalls}, normalize ${normCalls}`, delivCalls > 0 && normCalls > 0);
          v.check('Tiền đề: worker không khởi động lại giữa kịch bản (chuỗi mẫu liên tục)', `RestartCount ${r0} → ${r1}, exec nối lại ${sampler.resets} lần`, r1 === r0);
          v.check('factor{db} lên 1 (chế độ dò) trong ≤ 10 s sau khi DB chết', `${(toProbeMs / 1000).toFixed(1)} s`, iProbe >= 0 && toProbeMs <= 10_000);
          v.check(
            'Chế độ dò (chặn trên tính từ mốc factor = 1 cộng 6 s, tới khi DB về): mọi cửa sổ ≤ 5 s có ≤ 2 lần chạm DB trên đường consumer (normalize + delivery)',
            `max ${w5.max} (${w5.windows} cửa sổ, ${probeCalls} lần / ${probeSpanS.toFixed(0)} s = ${(probeCalls / Math.max(1, probeSpanS / 5)).toFixed(2)} / 5 s); 6 s đầu sau factor = 1: ${inflightBurst} lỗi của permit cấp trước đó, max thô ${w5raw.max}`,
            w5.max >= 0 && w5.max <= 2,
          );
          v.check('Chế độ dò theo lane: mọi cửa sổ ≤ 5 s có ≤ 1 lần chạm DB mỗi lane', `delivery max ${w5d.max}, normalize max ${w5n.max}`, w5d.max >= 0 && w5d.max <= 1 && w5n.max >= 0 && w5n.max <= 1);
          const logSpan = logUntil - win.downAt;
          v.check(`Log delivery hạ tầng gộp ≤ 1 dòng / 30 s (≤ ${Math.ceil(logSpan / 30_000) + 1} dòng trong ${Math.round(logSpan / 1000)} s, từ lúc phá tới factor = 0)`, `${deliveryWarn} dòng`, deliveryWarn <= Math.ceil(logSpan / 30_000) + 1);
          v.check('Log normalize: 0 dòng warn "Lỗi tạm" sau khi factor = 1 (DB đã biết ốm -> debug)', `${normWarnAfterProbe} dòng`, normWarnAfterProbe === 0);
          v.check('Log consumer (normalize + delivery, warn/error) không xả: ≤ 5 dòng / giây', `max ${consumerRate.maxPerSec} dòng/s, tổng ${consumerRate.total}`, consumerRate.maxPerSec <= 5);
          v.check('Delivery: lỗi DB xếp transient (không rơi vào nhánh unknown -> DLQ)', `transient ${infraKinds.transient}, unknown ${infraKinds.unknown}`, infraKinds.unknown === 0);

          v.finish('chaos-bp-T4.json', {
            params: { downMs: DOWN, n: N, sinkDelayMs: 1000, mode: 'kill' },
            window: win,
            preload: { acked: pre.st.acked.size, depths: pre.depths, readyMet: pre.readyMet },
            counts: { deliveryDbCalls: delivCalls, normalizeDbCalls: normCalls, infraKinds, toProbeMs, probeCalls, probeSpanS, maxPer5s: w5, maxPer5sDelivery: w5d, maxPer5sNormalize: w5n, maxPer5sRawFromFactor1: w5raw, firstWave: { deliveryDbCalls: iProbe >= 0 ? sampler.delta(iDown, iSteady, DELIVERY_DB) : null, normalizeDbCalls: iProbe >= 0 ? sampler.delta(iDown, iSteady, NORMALIZE_DB) : null, untilMs: iSteady >= 0 ? sampler.samples[iSteady].t - win.downAt : null }, logWindowMs: logSpan, inflightBurstAfterFactor1: inflightBurst, spilled, factorZeroAfterUpMs: iZero >= 0 ? sampler.samples[iZero].t - win.startedAt : null },
            firstSeconds: firstSecs,
            logs: { all: { total: rate.total, maxPerSec: rate.maxPerSec }, perMsg: rate.perMsg, deliveryWarn, normWarnAfterProbe, consumer: { total: consumerRate.total, maxPerSec: consumerRate.maxPerSec }, relayErrorLines: relayLines },
            queues: { before: q0, after: q1 },
            sink: { requests: sinkReqs.length, webhookIdsDeliveredMoreThanOnce: sinkDup },
            drain,
            series,
          });
        }),
    },
    {
      name: '[BP:T21] (phần b) LOCAL hubv: dừng Postgres 10 phút dưới tải đều — q.normalize.dlq tăng ≤ 5; DB về thì mọi sự kiện được xử lý (0 mất, 0 trùng)',
      tags: ['chaos-bp', 'bp-t21', 'BP5'],
      fn: () =>
        guarded(async () => {
          const DOWN = envMs('BP_T21_DOWN_MS', 600_000);
          const N = envMs('BP_T21_N', 1500);
          const v = new Verdicts();
          const w = await world('bp21');
          await sinkReset();
          const q0 = await queueCountsExact();
          const sampler = new MetricsSampler();
          const pre = await preloadBacklog(w.src, {
            n: N,
            ready: (d) => (d['q.normalize']?.total ?? 0) >= Math.min(400, N / 2),
            timeoutMs: 60_000,
            onStarted: () => sampler.start(),
          });
          console.log(`  backlog normalize trước khi phá: ${JSON.stringify(pre.depths)} (ready=${pre.readyMet})`);
          const r0 = await restartCount('hub-worker');
          const load = paced(w.src, 0.5); // tải đều: 1 sự kiện / 2 s suốt cửa sổ (provider nhận 5xx khi DB chết -> gửi lại sau)
          const win = await holdDown('stop', DOWN, async (ms) => {
            if (Math.floor(ms / 1000) % 60 === 0 && sampler.samples.length) {
              const last = sampler.samples[sampler.samples.length - 1];
              console.log(`  … ${Math.round(ms / 1000)} s: factor ${MetricsSampler.value(last, 'hub_backpressure_factor', { dependency: 'db' })}, spilled ${MetricsSampler.value(last, 'hub_backpressure_spilled_total')}`);
            }
          });
          console.log(`  Postgres stop ${Math.round((win.startedAt - win.downAt) / 1000)} s, nhận kết nối lại sau ${Math.round((win.readyAt - win.startedAt) / 1000)} s`);
          await sleep(10_000); // tải đều tiếp 10 s sau khi DB về
          const st = await load.stop();
          console.log(`  tải đều: ${st.ids.length} id, 2xx lần đầu ${st.acked.size}, lỗi ${st.failed.size} -> provider gửi lại`);
          await redeliver(w.src, [...st.failed], 4);
          const ids = [...pre.st.ids, ...st.ids];
          const acked = new Set([...pre.st.acked, ...st.acked]);
          let drain: { waitedMs: number } | null = null;
          await v.soft('DB về: mọi sự kiện được xử lý — 0 mất / 0 trùng / mọi delivery SUCCEEDED', async () => {
            drain = await assertExactlyOnce(w.src, ids, acked, 'T21', 600_000);
            return `${ids.length}/${ids.length} sau ${Math.round(drain.waitedMs / 1000)} s kể từ lúc provider gửi lại xong`;
          });
          await sleep(6000);
          sampler.stop();
          const r1 = await restartCount('hub-worker');
          const q1 = await queueCountsExact();
          const dlq = (q1['q.normalize.dlq'] ?? 0) - (q0['q.normalize.dlq'] ?? 0);

          const iDown = Math.max(0, sampler.indexAt(win.downAt) - 1); // mẫu cuối TRƯỚC lúc phá
          const iUp = sampler.indexAt(win.startedAt) - 1;
          const normCalls = sampler.delta(iDown, iUp, NORMALIZE_DB);
          const delivCalls = sampler.delta(iDown, iUp, DELIVERY_DB);
          const iProbe = (() => {
            for (let i = iDown; i <= iUp; i++) if (FACTOR(sampler, i) >= 1) return i;
            return -1;
          })();
          const iSteady = iProbe >= 0 ? sampler.indexAt(sampler.samples[iProbe].t + PRISMA_CONNECT_TIMEOUT_MS + 1000) : -1;
          const w5 = iSteady >= 0 && iSteady < iUp ? maxPer5s(sampler, iSteady, iUp) : { max: -1, at: 0, windows: 0 };
          const steadyCalls = iSteady >= 0 ? sampler.delta(iSteady, iUp, [...DELIVERY_DB, ...NORMALIZE_DB]) : -1;
          const NONE = { max: -1, at: 0, windows: 0 };
          const w5d = iSteady >= 0 && iSteady < iUp ? maxPer5s(sampler, iSteady, iUp, DELIVERY_DB) : NONE;
          const w5n = iSteady >= 0 && iSteady < iUp ? maxPer5s(sampler, iSteady, iUp, NORMALIZE_DB) : NONE;
          const steadySpanS = iSteady >= 0 ? (sampler.samples[iUp].t - sampler.samples[iSteady].t) / 1000 : 0;
          const spilled = sampler.delta(iDown, sampler.samples.length - 1, [{ name: 'hub_backpressure_spilled_total' }]);
          const deferred = sampler.delta(iDown, sampler.samples.length - 1, [{ name: 'hub_normalize_deferred_total' }]);
          const retries = sampler.delta(iDown, sampler.samples.length - 1, [{ name: 'hub_normalize_retries_total' }]);
          const iZero = (() => {
            for (let i = iUp + 1; i < sampler.samples.length; i++) if (FACTOR(sampler, i) === 0) return i;
            return -1;
          })();
          const series = perSampleSeries(sampler, iDown, sampler.samples.length - 1, win.downAt).filter((x, i) => i % 5 === 0 || x.s > DOWN / 1000 - 5);
          const logs = await workerLogs(win.downAt, win.startedAt);
          const rate = logRate(logs);

          v.check('Tiền đề: Postgres chết THẬT suốt cửa sổ', `${win.unexpectedlyUp} lần thấy đang chạy; ${Math.round((win.startedAt - win.downAt) / 1000)} s`, win.unexpectedlyUp === 0 && win.startedAt - win.downAt >= DOWN);
          v.check('Tiền đề: lane normalize có hàng chạm DB trong lúc DB chết (dưới tải)', `normalize ${normCalls} lần chạm DB (delivery ${delivCalls})`, normCalls > 0);
          v.check('Tiền đề: worker không khởi động lại giữa kịch bản', `RestartCount ${r0} → ${r1}, exec nối lại ${sampler.resets} lần`, r1 === r0);
          v.check('(đo thêm) chế độ dò suốt 10 phút (từ factor = 1 cộng 6 s): mọi cửa sổ ≤ 5 s có ≤ 2 lần chạm DB trên đường consumer (normalize + delivery)', `max ${w5.max}; ${steadyCalls} lần / ${steadySpanS.toFixed(0)} s = ${(steadyCalls / Math.max(1, steadySpanS / 5)).toFixed(2)} / 5 s`, w5.max >= 0 && w5.max <= 2);
          v.check('(đo thêm) chế độ dò theo lane: mọi cửa sổ ≤ 5 s có ≤ 1 lần chạm DB mỗi lane', `delivery max ${w5d.max}, normalize max ${w5n.max}`, w5d.max >= 0 && w5d.max <= 1 && w5n.max >= 0 && w5n.max <= 1);
          v.check('q.normalize.dlq tăng ≤ 5 (đếm chính xác rabbitmqctl, trước/sau)', `+${dlq} (${q0['q.normalize.dlq'] ?? 0} → ${q1['q.normalize.dlq'] ?? 0})`, dlq <= 5);

          v.finish('chaos-bp-T21.json', {
            params: { downMs: DOWN, n: N, steadyPerSec: 0.5, mode: 'stop' },
            window: win,
            preload: { acked: pre.st.acked.size, depths: pre.depths, readyMet: pre.readyMet },
            steady: { ids: st.ids.length, acked: st.acked.size, failed: st.failed.size },
            counts: { normalizeDbCalls: normCalls, deliveryDbCalls: delivCalls, toProbeMs: iProbe >= 0 ? sampler.samples[iProbe].t - win.downAt : null, maxPer5s: w5, maxPer5sDelivery: w5d, maxPer5sNormalize: w5n, steadyCalls, steadySpanS, normalizeDeferred: deferred, normalizeRetriesBurned: retries, spilled, factorZeroAfterUpMs: iZero >= 0 ? sampler.samples[iZero].t - win.startedAt : null, dlqDelta: dlq },
            logs: { total: rate.total, maxPerSec: rate.maxPerSec, perMsg: rate.perMsg },
            queues: { before: q0, after: q1 },
            drain,
            series,
          });
        }),
    },
    {
      name: '[BP:T16] (phần b) LOCAL hubv: đích chết 10 phút với 500 delivery hoãn → hồi phục — không giây nào vượt trần ramp (2,4,…,64 rps; bậc cuối 64 được gia hạn khi còn bị chặn, ≤ RAMP_MAX 180 s — ADR-234; sau ramp ≤ 64/s)',
      tags: ['chaos-bp', 'bp-t16', 'BP4'],
      fn: () =>
        guarded(async () => {
          const DOWN = envMs('BP_T16_DOWN_MS', 600_000);
          const N = envMs('BP_T16_N', 500);
          // Mặc định của worker — một nguồn với code (review Thấp 4); hubv không đặt env DELIVERY_RAMP_*.
          const RAMP = { start: DELIVERY_RAMP_START_RPS, stepS: DELIVERY_RAMP_STEP_SECONDS, seconds: DELIVERY_RAMP_SECONDS, maxS: deliveryRampConfig({}).maxSeconds };
          const v = new Verdicts();
          const w = await world('bp16');
          await sinkReset();
          const r0 = await restartCount('hub-worker');
          await sinkMode(w.sinkPath, { mode: 'fail' });
          const tDown = Date.now();
          const st = await blast(w.src, newIds(N), 8);
          await redeliver(w.src, [...st.failed], 4);
          console.log(`  đích chết lúc ${new Date(tDown).toISOString()}; ${N} id (2xx ${st.acked.size})`);
          const redis = hubvRedis();
          const circuitLog: { s: number; open: number; trips: string | null; hits: number }[] = [];
          while (Date.now() - tDown < DOWN) {
            await sleep(Math.min(30_000, DOWN - (Date.now() - tDown)));
            const hits = (await sinkRequests(w.sinkPath)).filter((r) => Date.parse(r.at) >= tDown).length;
            const open = await redis.pttl(`circuit:${w.endpointId}:open`);
            const trips = await redis.get(`circuit:${w.endpointId}:trips`);
            circuitLog.push({ s: Math.round((Date.now() - tDown) / 1000), open, trips, hits });
            console.log(`  … ${Math.round((Date.now() - tDown) / 1000)} s: request đập vào đích chết ${hits}, :open PTTL ${open} ms, :trips ${trips}`);
          }
          const before = ledger(w.src, st.ids);
          const downReqs = (await sinkRequests(w.sinkPath)).filter((r) => Date.parse(r.at) >= tDown);
          await sinkMode(w.sinkPath, {});
          const tUp = Date.now();
          console.log(`  đích SỐNG lại sau ${Math.round((tUp - tDown) / 1000)} s; hàng hoãn: ${before.del} delivery, ${before.ok} SUCCEEDED; ${downReqs.length} request đã đập vào đích chết`);
          const rampStart = Number(
            await waitFor('probe thành công -> circuit:{id}:ramp', async () => redis.get(`circuit:${w.endpointId}:ramp`), 15 * 60_000, 250),
          );
          console.log(`  probe thành công, ramp bắt đầu ${new Date(rampStart).toISOString()} (${Math.round((rampStart - tUp) / 1000)} s sau khi đích sống)`);
          // F3 (ADR-232 + ADR-234): khoá :ramp sống ramp + một bậc (70 s); gate gia hạn ở bậc cuối khi còn bị chặn, tối đa RAMP_MAX
          // tính từ rampStart -> hết ramp = lúc khoá BIẾN MẤT (dò 250 ms), không còn cố định 70 s.
          await waitFor('khoá circuit:{id}:ramp hết hạn', async () => ((await redis.exists(`circuit:${w.endpointId}:ramp`)) === 0 ? true : null), (RAMP.maxS + 30) * 1000, 250);
          const rampEnd = Math.min(Date.now(), rampStart + RAMP.maxS * 1000);
          const rampLenMs = Date.now() - rampStart;
          await sleep(5000);
          const lastStep = deliveryRampLastStep({ startRps: RAMP.start, stepSeconds: RAMP.stepS, seconds: RAMP.seconds, maxSeconds: RAMP.maxS });
          const finalCap = RAMP.start * 2 ** lastStep;
          /** Số request tới sink theo giây epoch, chỉ tính request trong [from, to). */
          const bySecond = (reqs: { at: string }[], from: number, to: number) => {
            const m = new Map<number, number>();
            for (const r of reqs) {
              const at = Date.parse(r.at);
              if (at < from || at >= to) continue;
              m.set(Math.floor(at / 1000), (m.get(Math.floor(at / 1000)) ?? 0) + 1);
            }
            return m;
          };
          const reqs = (await sinkRequests(w.sinkPath)).filter((r) => Date.parse(r.at) >= tUp);
          // Trong ramp: chỉ request tới khi `:ramp` còn sống [rampStart, rampEnd). Probe (HALF_OPEN) tới TRƯỚC rampStart — không thuộc trần.
          const perSec = bySecond(reqs, rampStart, rampEnd);
          // Trần của giây epoch S (khoá throttle theo giây epoch): trần tại thời điểm CUỐI phần giây còn ramp (trần tăng giữa giây thì cả giây được tới mức mới).
          const capOf = (s: number) => RAMP.start * 2 ** Math.min(lastStep, Math.floor((Math.min(s * 1000 + 999, rampEnd - 1) - rampStart) / (RAMP.stepS * 1000)));
          const rows: { s: number; t: number; n: number; cap: number }[] = [];
          for (let s = Math.floor(rampStart / 1000); s * 1000 < rampEnd; s++) rows.push({ s: s - Math.floor(rampStart / 1000), t: s, n: perSec.get(s) ?? 0, cap: capOf(s) });
          const over = rows.filter((r) => r.n > r.cap);
          const inRamp = rows.reduce((a, r) => a + r.n, 0);
          const probeReqs = reqs.filter((r) => Date.parse(r.at) < rampStart).length;
          console.log(`  ramp (${Math.round(rampLenMs / 1000)} s, trần ${RAMP.maxS} s): ${inRamp} request; theo giây ${rows.map((r) => `${r.n}/${r.cap}`).join(' ')}`);

          let drain: { waitedMs: number } | null = null;
          await v.soft('Hồi phục: mọi delivery SUCCEEDED, 0 DEAD, 0 trùng (Postgres)', async () => {
            drain = await assertExactlyOnce(w.src, st.ids, st.acked, 'T16', 20 * 60_000);
            return `${N}/${N} sau ${Math.round((Date.now() - tUp) / 1000)} s kể từ đích sống`;
          });
          const fin = ledger(w.src, st.ids);
          // Sau ramp (khoá :ramp hết hạn): hàng tồn còn lại tới với tốc độ bình thường — đo để báo cáo, không phải tiêu chí T16.
          const afterMap = bySecond((await sinkRequests(w.sinkPath)).filter((r) => Date.parse(r.at) >= tUp), rampEnd, Infinity);
          const after = [...afterMap.entries()].sort((a, b) => a[0] - b[0]);
          const afterMax = after.reduce((m, [, n]) => Math.max(m, n), 0);
          const afterTotal = after.reduce((m, [, n]) => m + n, 0);
          console.log(`  sau ramp: ${afterTotal} request, max ${afterMax}/s; ${after.slice(0, 15).map(([s, n]) => `+${s - Math.floor(rampStart / 1000)}s:${n}`).join(' ')}`);
          const r1 = await restartCount('hub-worker');

          v.check('Tiền đề: 500 delivery hoãn lúc đích sống lại (0 SUCCEEDED)', `${before.del} delivery, ${before.ok} SUCCEEDED`, before.del === N && before.ok === 0);
          v.check('Tiền đề: worker không khởi động lại', `RestartCount ${r0} → ${r1}`, r0 === r1);
          v.check(`ADR-234: khoá :ramp không sống quá RAMP_MAX ${RAMP.maxS} s kể từ rampStart`, `${Math.round(rampLenMs / 1000)} s`, rampLenMs <= RAMP.maxS * 1000 + 1000);
          v.check('Không giây nào trong ramp vượt trần (2,4,8,16,32,64 rps, rồi giữ 64 tới khi khoá hết hạn)', over.length ? `${over.length} giây vượt: ${over.map((o) => `+${o.s}s ${o.n}>${o.cap}`).join(', ')}` : `0 giây vượt; ${inRamp} request trong ramp`, over.length === 0);
          v.check(`Sau ramp (khoá :ramp hết hạn, F3): không giây nào vượt trần cuối ${finalCap}/s`, `max ${afterMax}/s, ${afterTotal} request sau ramp`, afterMax <= finalCap);
          v.check('0 DEAD', `${fin.dead}`, fin.dead === 0);

          v.finish('chaos-bp-T16.json', {
            params: { downMs: DOWN, n: N, ramp: RAMP },
            down: { at: tDown, upAt: tUp, requestsHitDeadDestination: downReqs.length, circuitLog },
            rampStart,
            rampLenMs,
            rampStartAfterUpMs: rampStart - tUp,
            probeRequestsBeforeRamp: probeReqs,
            ramp: rows,
            afterRamp: after.map(([s, n]) => ({ s: s - Math.floor(rampStart / 1000), n })),
            afterRampMaxPerSec: afterMax,
            afterRampTotal: afterTotal,
            requestsInRamp: inRamp,
            final: fin,
            drain,
          });
        }),
    },
  ],
};

export default file;
