/**
 * Đồ nghề chaos L3 dùng chung (VF5 chaos-l3, BP chaos-bp, sau này LH6 lưới hứng chaos) — ADR-193.
 *
 * Luật (SPEC-verification §4.1): mọi lệnh docker đi qua `docker compose -p hubv …` (composeBaseArgs), KHÔNG BAO GIỜ tên
 * container cứng, không đụng stack dev `webhook-hub` hay container khác trên máy. Chỉ chạy vào hubv local (guard ở e2e-world).
 *
 * Nhóm hàm:
 *   - provider giả: `blast` / `stream` / `paced` / `redeliver` — hành xử như provider THẬT (không 2xx thì gửi lại y hệt);
 *   - sổ cái Postgres: `ledger` / `assertExactlyOnce` / `pendingAt` — 0 mất / 0 trùng / BB-3, Postgres là trọng tài (BB-2);
 *   - phá hạ tầng: `postgresDown` / `postgresUp` / `holdDown` / `preloadBacklog` — "giết Postgres DƯỚI TẢI";
 *   - quan sát worker: `MetricsSampler` (/metrics của hub-worker, đọc TRONG container — không publish cổng), `workerLogs`,
 *     `queueDepth` (RabbitMQ management của hubv), `restartCount`;
 *   - đích điều khiển được: `sinkMode` / `sinkRequests` (tools/verify-sink, PUT /_mode theo path).
 */
import { spawn } from 'child_process';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import { childEnv, composeBaseArgs, composeOutput, hostUrls, PORTS, ROOT } from './compose';
import { psql, sendFixture, SINK, sleep, uniq } from './e2e-world';
import { expect } from './http-session';
import { waitFor } from './scenario';

// ---------------------------------------------------------------------------------------------------------------- docker

/**
 * `docker compose -p hubv …` KHÔNG chặn event loop (spawn, không spawnSync): loạt request phải tiếp tục bay TRONG lúc
 * container bị kill/restart — spawnSync làm loạt request đứng im đúng lúc cần phá.
 */
export function dc(args: string[], timeoutMs = 180_000): Promise<string> {
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

export async function apiHealthy(timeoutMs = 90_000): Promise<void> {
  await waitFor('hub-api /health 200', async () => (await fetch(`${process.env.VERIFY_API_URL || hostUrls().HUB_API_URL}/health`).catch(() => null))?.ok, timeoutMs, 1000);
}

/** Service của hubv đang chạy (state running)? Qua compose, không tên container. */
export async function serviceRunning(service: string): Promise<boolean> {
  const out = await dc(['ps', '--status', 'running', '-q', service], 30_000).catch(() => '');
  return out.trim().length > 0;
}

/** Số lần Docker tự khởi động lại container của service (restart policy) — tăng = tiến trình chết giữa kịch bản. */
export async function restartCount(service: string): Promise<number> {
  const id = (await dc(['ps', '-a', '-q', service], 30_000)).trim().split('\n')[0];
  if (!id) return -1;
  const r = await new Promise<string>((resolve) => {
    const p = spawn('docker', ['inspect', '-f', '{{.RestartCount}}', id]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
  });
  return Number(r);
}

/** Mọi container hubv chạy lại (dù kịch bản đỏ giữa chừng) — không để phá kịch bản sau. */
export async function heal(): Promise<void> {
  composeOutput(['unpause', 'postgres'], 30_000);
  composeOutput(['start', 'postgres', 'redis', 'rabbitmq', 'hub-api', 'hub-worker', 'sink'], 120_000);
  await postgresReady(120_000).catch(() => undefined);
  await apiHealthy().catch(() => undefined);
  await fetch(`${SINK}/_mode`, { method: 'DELETE' }).catch(() => undefined);
}

export async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    await heal();
  }
}

// ------------------------------------------------------------------------------------------------------- provider giả

/** Source GitHub của một dev trên hubv (hub-sim ký fixture `github/push`). */
export interface ChaosSource {
  id: string;
  webhookUrl: string;
}

export type StreamState = { ids: string[]; acked: Set<string>; failed: Set<string> };
export const newState = (): StreamState => ({ ids: [], acked: new Set(), failed: new Set() });

async function sendOnce(src: ChaosSource, id: string, st: StreamState): Promise<boolean> {
  try {
    const r = await sendFixture('github/push', src.webhookUrl, id);
    const ok = r.status >= 200 && r.status < 300;
    (ok ? st.acked : st.failed).add(id);
    return ok;
  } catch {
    st.failed.add(id);
    return false;
  }
}

/** Gửi `ids` như provider: song song `conc`, ghi lại id đã nhận 2xx ở lần đầu. */
export async function blast(src: ChaosSource, ids: string[], conc = 8, st: StreamState = newState()): Promise<StreamState> {
  let i = 0;
  st.ids.push(...ids);
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (i < ids.length) await sendOnce(src, ids[i++], st);
    }),
  );
  return st;
}

/** Provider gửi lại mọi id chưa 2xx tới khi 2xx (backoff 1 s, tối đa `perIdMs` mỗi id), song song `conc`. */
export async function redeliver(src: ChaosSource, ids: Iterable<string>, conc = 1, perIdMs = 120_000): Promise<void> {
  const list = [...ids];
  let i = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (i < list.length) {
        const id = list[i++];
        await waitFor(`gửi lại ${id} tới khi 2xx`, async () => {
          const r = await sendFixture('github/push', src.webhookUrl, id).catch(() => null);
          return r && r.status >= 200 && r.status < 300;
        }, perIdMs, 1000);
      }
    }),
  );
}

/** Bắn liên tục id MỚI trong `ms` mili-giây, hết tốc với `conc` luồng (để chắc chắn có request đang bay lúc phá). */
export async function stream(src: ChaosSource, ms: number, conc = 6, st: StreamState = newState()): Promise<StreamState> {
  const until = Date.now() + ms;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (Date.now() < until) {
        const id = uniq();
        st.ids.push(id);
        if (!(await sendOnce(src, id, st))) await sleep(100); // api chết: lỗi kết nối tức thì — đừng quay vòng nóng
      }
    }),
  );
  return st;
}

/**
 * Tải ĐỀU: `perSec` id mới mỗi giây trong `ms` (bắn-và-quên theo nhịp, không chờ phản hồi — request treo vì DB chết không
 * làm nhịp chậm lại). Trả hàm dừng + promise chờ mọi request đã bắn xong.
 */
export function paced(src: ChaosSource, perSec: number, st: StreamState = newState()): { stop: () => Promise<StreamState> } {
  const inflight = new Set<Promise<unknown>>();
  const timer = setInterval(() => {
    const id = uniq();
    st.ids.push(id);
    const p = sendOnce(src, id, st).finally(() => inflight.delete(p));
    inflight.add(p);
  }, Math.max(10, Math.round(1000 / perSec)));
  return {
    stop: async () => {
      clearInterval(timer);
      await Promise.all([...inflight]);
      return st;
    },
  };
}

/**
 * `n` id KHÁC NHAU. `uniq()` = 6 chữ số ms + seq % 1000 -> sinh > 1000 id trong cùng một ms thì lặp (gửi trùng = "mất" giả
 * trong sổ cái); bỏ id đã có, chờ đồng hồ sang ms mới.
 */
export function newIds(n: number): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(uniq());
  return [...out];
}

// ------------------------------------------------------------------------------------------------------ sổ cái Postgres

export interface Ledger {
  raw: number;
  rawIds: number;
  ev: number;
  evIds: number;
  del: number;
  ok: number;
  dupDel: number;
  dead: number;
}

/** Đếm theo delivery id GitHub (`sim-push-<u>`): raw ACCEPTED, event, delivery/SUCCEEDED/DEAD cho đúng tập id. */
export function ledger(src: ChaosSource, ids: string[]): Ledger {
  if (ids.length === 0) return { raw: 0, rawIds: 0, ev: 0, evIds: 0, del: 0, ok: 0, dupDel: 0, dead: 0 };
  const list = ids.map((u) => `'sim-push-${u}'`).join(',');
  const row = psql(
    `with r as (select id, headers->>'x-github-delivery' d from hub.raw_events where source_id = '${src.id}' and status = 'ACCEPTED' and headers->>'x-github-delivery' in (${list})),
          e as (select e.id, r.d from hub.events e join r on r.id = e.raw_event_id)
     select (select count(*) from r), (select count(distinct d) from r), (select count(*) from e), (select count(distinct d) from e),
            (select count(*) from hub.deliveries x join e on e.id = x.event_id),
            (select count(*) from hub.deliveries x join e on e.id = x.event_id where x.status = 'SUCCEEDED'),
            (select count(*) from (select x.event_id from hub.deliveries x join e on e.id = x.event_id group by x.event_id, x.subscription_id having count(*) > 1) z),
            (select count(*) from hub.deliveries x join e on e.id = x.event_id where x.status = 'DEAD')`,
  );
  const [raw, rawIds, ev, evIds, del, ok, dupDel, dead] = row.split('|').map(Number);
  return { raw, rawIds, ev, evIds, del, ok, dupDel, dead };
}

/**
 * M-2 (review VF): tiền đề "phá GIỮA CHỪNG" — ngay lúc phá phải có id đã nhận 2xx (đã COMMIT) mà delivery CHƯA
 * SUCCEEDED. Không có thì kịch bản không phá được gì (xanh suông) -> đỏ.
 */
export function pendingAt(src: ChaosSource, st: StreamState, label: string): number {
  const acked = [...st.acked];
  if (acked.length === 0) throw new Error(`${label}: chưa id nào được nhận lúc phá — kịch bản phá quá sớm`);
  const l = ledger(src, acked);
  const pending = acked.length - l.ok;
  console.log(`  ${label}: lúc phá có ${acked.length} id đã 2xx, ${pending} chưa giao xong`);
  expect(pending > 0, `${label}: lúc phá KHÔNG có việc dở (mọi id đã giao) — kịch bản không phá được gì`);
  return pending;
}

/** 0 mất / 0 trùng / mọi delivery SUCCEEDED, chờ tối đa `timeoutMs` cho worker xử lý xong. Trả sổ cái cuối + ms đã chờ. */
export async function assertExactlyOnce(src: ChaosSource, ids: string[], acked: Set<string>, label: string, timeoutMs = 120_000): Promise<{ final: Ledger; waitedMs: number }> {
  const n = ids.length;
  const t0 = Date.now();
  const final = await waitFor(`${label}: ${n} id → ${n} event, ${n} delivery SUCCEEDED`, async () => {
    const l = ledger(src, ids);
    return l.ev >= n && l.ok >= n ? l : null;
  }, timeoutMs, 2000).catch(() => ledger(src, ids));
  const waitedMs = Date.now() - t0;
  // BB-3: mọi id đã nhận 2xx ở lần đầu phải có raw_event — đếm riêng tập acked.
  const ackedList = [...acked];
  const ackedHave = ackedList.length ? ledger(src, ackedList).rawIds : 0;
  const msg = `${label}: gửi ${n} id (2xx lần đầu ${acked.size}) → raw ${final.raw}/${final.rawIds} id · event ${final.ev}/${final.evIds} id · delivery ${final.ok}/${final.del} SUCCEEDED · DEAD ${final.dead} · trùng delivery ${final.dupDel}`;
  console.log(`  ${msg} (chờ ${Math.round(waitedMs / 1000)} s)`);
  expect(ackedHave === acked.size, `BB-3: ${acked.size - ackedHave} id đã nhận 2xx mà KHÔNG có raw_event (ACK trước COMMIT)`);
  expect(final.raw === n && final.rawIds === n, `mất/trùng ở ingest — ${msg}`);
  expect(final.ev === n && final.evIds === n, `mất/trùng event — ${msg}`);
  expect(final.del === n && final.ok === n && final.dupDel === 0, `delivery thiếu/trùng/chưa SUCCEEDED — ${msg}`);
  return { final, waitedMs };
}

// ------------------------------------------------------------------------------------------------- phá Postgres dưới tải

export type PgDownMode = 'stop' | 'kill';

/** Postgres hubv nhận kết nối (pg_isready trong container). */
export async function postgresReady(timeoutMs = 120_000): Promise<void> {
  await waitFor('postgres hubv pg_isready', async () => {
    const out = await dc(['exec', '-T', 'postgres', 'pg_isready', '-U', 'hub_user', '-d', 'webhook_hub'], 15_000).catch(() => '');
    return /accepting connections/.test(out);
  }, timeoutMs, 1000);
}

/** Dừng Postgres hubv: `stop` (SIGINT = fast shutdown, như Neon cắt) hoặc `kill` (SIGKILL, như máy chết). Trả mốc ms. */
export async function postgresDown(mode: PgDownMode): Promise<number> {
  // Mốc = lúc PHÁT lệnh: Postgres chết ngay khi lệnh tới daemon, `docker compose` trả về chậm hơn ~0,5 s — lấy mốc sau lệnh
  // thì đợt lỗi đầu tiên rơi ra ngoài cửa sổ đo.
  const at = Date.now();
  if (mode === 'kill') await dc(['kill', '-s', 'SIGKILL', 'postgres']);
  else await dc(['stop', '-t', '10', 'postgres']);
  return at;
}

/** Khởi động lại Postgres hubv, chờ nhận kết nối. */
export async function postgresUp(timeoutMs = 120_000): Promise<{ startedAt: number; readyAt: number }> {
  const startedAt = Date.now();
  await dc(['start', 'postgres']);
  await postgresReady(timeoutMs);
  return { startedAt, readyAt: Date.now() };
}

export interface DownWindow {
  mode: PgDownMode;
  downAt: number;
  startedAt: number;
  readyAt: number;
  /** Lần kiểm (mỗi ~5 s) thấy Postgres ĐANG chạy giữa cửa sổ chết (restart policy dựng lại?) — phải bằng 0. */
  unexpectedlyUp: number;
}

/**
 * Giữ Postgres CHẾT đúng `ms` (tính từ lúc lệnh dừng xong), mỗi ~5 s kiểm container vẫn không chạy (cửa sổ chết phải THẬT),
 * gọi `onTick` mỗi giây (lấy mẫu). Rồi dựng lại và chờ nhận kết nối.
 */
export async function holdDown(mode: PgDownMode, ms: number, onTick?: (elapsedMs: number) => void | Promise<void>): Promise<DownWindow> {
  const downAt = await postgresDown(mode);
  let unexpectedlyUp = 0;
  let lastCheck = 0;
  while (Date.now() - downAt < ms) {
    await sleep(Math.min(1000, ms - (Date.now() - downAt)));
    await onTick?.(Date.now() - downAt);
    if (Date.now() - lastCheck >= 5000) {
      lastCheck = Date.now();
      if (await serviceRunning('postgres')) unexpectedlyUp++;
    }
  }
  const { startedAt, readyAt } = await postgresUp();
  return { mode, downAt, startedAt, readyAt, unexpectedlyUp };
}

/**
 * Dựng TẢI ĐANG BAY trên cả hai lane (normalize + delivery) rồi mới phá — "giết Postgres dưới tải":
 *   1. dừng hub-worker (outbox tích lại trong Postgres: hub-api vẫn COMMIT + 2xx, relay nằm trong worker),
 *   2. provider bắn `n` id (song song `conc`),
 *   3. bật lại hub-worker: relay đẩy cả lô vào q.normalize nhanh hơn normalize xử lý; delivery bị đích chậm (sinkMode
 *      delayMs) giữ lại -> q.delivery.main dồn,
 *   4. trả về khi `ready(depths)` đúng (hoặc hết `timeoutMs` — kịch bản tự kiểm tiền đề sau).
 */
export async function preloadBacklog(src: ChaosSource, o: { n: number; conc?: number; ready: (d: Record<string, QueueDepth>) => boolean; timeoutMs?: number; onStarted?: () => void }): Promise<{ st: StreamState; depths: Record<string, QueueDepth>; readyMet: boolean }> {
  await dc(['stop', '-t', '25', 'hub-worker']);
  const st = await blast(src, newIds(o.n), o.conc ?? 8);
  await redeliver(src, [...st.failed], 4);
  await dc(['start', 'hub-worker']);
  o.onStarted?.();
  let depths: Record<string, QueueDepth> = {};
  const until = Date.now() + (o.timeoutMs ?? 90_000);
  let readyMet = false;
  while (Date.now() < until) {
    depths = await queueReady(['q.normalize', 'q.delivery.main']).catch(() => depths);
    if (o.ready(depths)) {
      readyMet = true;
      break;
    }
    await sleep(100);
  }
  return { st, depths, readyMet };
}

// -------------------------------------------------------------------------------------------------- RabbitMQ của hubv

export interface QueueDepth {
  ready: number;
  unacked: number;
  total: number;
}

const rabbitAuth = () => 'Basic ' + Buffer.from(`${new URL(hostUrls().RABBITMQ_URL).username}:${new URL(hostUrls().RABBITMQ_URL).password}`).toString('base64');

/** Độ sâu queue qua management API của hubv (localhost:25672). Số của management trễ tối đa ~5 s (chu kỳ thống kê). */
export async function queueDepth(name: string): Promise<QueueDepth> {
  const r = await fetch(`http://localhost:${PORTS.rabbitUi}/api/queues/%2F/${encodeURIComponent(name)}`, { headers: { authorization: rabbitAuth() } });
  if (!r.ok) throw new Error(`RabbitMQ management ${name} → ${r.status}`);
  const q = (await r.json()) as { messages?: number; messages_ready?: number; messages_unacknowledged?: number };
  return { ready: q.messages_ready ?? 0, unacked: q.messages_unacknowledged ?? 0, total: q.messages ?? 0 };
}

let amqpConn: amqp.ChannelModel | null = null;
/**
 * Số message READY ngay lúc hỏi (AMQP passive declare — không qua thống kê trễ ~5 s của management). `unacked` không có ở
 * đường này (= 0); dùng cho điều kiện "đã có hàng dồn" trước khi phá.
 */
export async function queueReady(names: string[]): Promise<Record<string, QueueDepth>> {
  if (!amqpConn) {
    amqpConn = await amqp.connect(hostUrls().RABBITMQ_URL);
    amqpConn.on('error', () => undefined);
    amqpConn.on('close', () => (amqpConn = null));
  }
  const ch = await amqpConn.createChannel();
  ch.on('error', () => undefined);
  try {
    const out: Record<string, QueueDepth> = {};
    for (const n of names) {
      const q = await ch.checkQueue(n);
      out[n] = { ready: q.messageCount, unacked: 0, total: q.messageCount };
    }
    return out;
  } finally {
    await ch.close().catch(() => undefined);
  }
}

export async function closeChaosAmqp(): Promise<void> {
  await amqpConn?.close().catch(() => undefined);
  amqpConn = null;
}

export async function queueDepths(names: string[]): Promise<Record<string, QueueDepth>> {
  const out: Record<string, QueueDepth> = {};
  for (const n of names) out[n] = await queueDepth(n);
  return out;
}

/** Số message chính xác (không qua thống kê trễ của management) — `rabbitmqctl list_queues` trong container rabbitmq hubv. */
export async function queueCountsExact(): Promise<Record<string, number>> {
  const out = await dc(['exec', '-T', 'rabbitmq', 'rabbitmqctl', 'list_queues', '-q', '--no-table-headers', 'name', 'messages'], 60_000);
  const m: Record<string, number> = {};
  for (const ln of out.split('\n')) {
    const [name, n] = ln.trim().split(/\s+/);
    if (name && n !== undefined && /^\d+$/.test(n)) m[name] = Number(n);
  }
  return m;
}

// ------------------------------------------------------------------------------------------------ quan sát hub-worker

export interface MetricSample {
  t: number;
  v: Map<string, number>;
}

/**
 * Lấy mẫu `/metrics` của hub-worker mỗi `everyMs` bằng MỘT `docker compose exec` chạy lâu (node trong container gọi
 * 127.0.0.1:9101 — cổng metrics không publish ra host, S3-4). Chỉ giữ dòng `hub_*`. Đếm trong bộ nhớ của worker (0 lệnh
 * Redis). Worker khởi động lại (bộ đếm về 0) -> exec chết -> tự nối lại, `resets` tăng; `delta` coi giá trị giảm là reset.
 */
export class MetricsSampler {
  readonly samples: MetricSample[] = [];
  resets = 0;
  private proc: ReturnType<typeof spawn> | null = null;
  private stopped = false;

  constructor(private readonly service = 'hub-worker', private readonly everyMs = 1000, private readonly port = 9101) {}

  start(): this {
    this.stopped = false;
    this.spawn();
    return this;
  }

  private spawn(): void {
    const js = `const h=require('http');const tok=process.env.METRICS_TOKEN;setInterval(()=>{const q=h.get({host:'127.0.0.1',port:${this.port},path:'/metrics',headers:tok?{authorization:'Bearer '+tok}:{}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>process.stdout.write(JSON.stringify({t:Date.now(),l:b.split('\\n').filter(x=>x.startsWith('hub_'))})+'\\n'))});q.on('error',e=>process.stdout.write(JSON.stringify({t:Date.now(),err:e.message})+'\\n'));q.setTimeout(900,()=>q.destroy(new Error('timeout')))},${this.everyMs})`;
    const p = spawn('docker', [...composeBaseArgs(), 'exec', '-T', this.service, 'node', '-e', js], { cwd: ROOT, env: childEnv() });
    this.proc = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const o = JSON.parse(line) as { t: number; l?: string[] };
          if (!o.l) continue;
          const v = new Map<string, number>();
          for (const x of o.l) {
            const sp = x.lastIndexOf(' ');
            v.set(x.slice(0, sp), Number(x.slice(sp + 1)));
          }
          this.samples.push({ t: o.t, v });
        } catch {
          /* dòng dở */
        }
      }
    });
    p.on('close', () => {
      if (this.stopped) return;
      this.resets++;
      setTimeout(() => !this.stopped && this.spawn(), 1000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill('SIGKILL');
  }

  /** Giá trị của chuỗi (khớp tên + mọi nhãn trong `labels`), cộng mọi chuỗi khớp. */
  static value(s: MetricSample, name: string, labels: Record<string, string> = {}): number {
    let sum = 0;
    for (const [k, v] of s.v) {
      const brace = k.indexOf('{');
      const n = brace < 0 ? k : k.slice(0, brace);
      if (n !== name) continue;
      if (Object.entries(labels).every(([lk, lv]) => k.includes(`${lk}="${lv}"`))) sum += v;
    }
    return sum;
  }

  /** Mức tăng của tổng các bộ đếm `names` giữa mẫu i và j (bộ đếm giảm = worker khởi động lại -> lấy giá trị mới). */
  delta(i: number, j: number, names: { name: string; labels?: Record<string, string> }[]): number {
    let d = 0;
    for (let k = i + 1; k <= j; k++) {
      for (const c of names) {
        const a = MetricsSampler.value(this.samples[k - 1], c.name, c.labels);
        const b = MetricsSampler.value(this.samples[k], c.name, c.labels);
        d += b >= a ? b - a : b;
      }
    }
    return d;
  }

  /** Chỉ số mẫu đầu tiên có t >= ms. */
  indexAt(ms: number): number {
    const i = this.samples.findIndex((s) => s.t >= ms);
    return i < 0 ? this.samples.length - 1 : i;
  }
}

export interface LogLine {
  t: number;
  level: string;
  msg: string;
}

/** Log của service hubv trong [sinceMs, untilMs] (pino JSON; dòng không phải JSON tính level `raw`). */
export async function workerLogs(sinceMs: number, untilMs: number, service = 'hub-worker'): Promise<LogLine[]> {
  const out = await dc(['logs', '--no-color', '--no-log-prefix', '--since', new Date(sinceMs).toISOString(), '--until', new Date(untilMs).toISOString(), service], 120_000);
  const lines: LogLine[] = [];
  for (const ln of out.split('\n')) {
    if (!ln.trim()) continue;
    try {
      const o = JSON.parse(ln) as { time?: string; level?: string; msg?: string };
      lines.push({ t: o.time ? Date.parse(o.time) : 0, level: String(o.level ?? '?'), msg: String(o.msg ?? '') });
    } catch {
      lines.push({ t: 0, level: 'raw', msg: ln.slice(0, 200) });
    }
  }
  return lines;
}

/** Số dòng mỗi giây (theo `time` của dòng) — trả {max, total, perMsg}. */
export function logRate(lines: LogLine[], levels = ['warn', 'error', 'fatal']): { total: number; maxPerSec: number; perMsg: Record<string, number> } {
  const sel = lines.filter((l) => levels.includes(l.level));
  const perSec = new Map<number, number>();
  const perMsg: Record<string, number> = {};
  for (const l of sel) {
    const s = Math.floor(l.t / 1000);
    perSec.set(s, (perSec.get(s) ?? 0) + 1);
    perMsg[l.msg] = (perMsg[l.msg] ?? 0) + 1;
  }
  return { total: sel.length, maxPerSec: Math.max(0, ...perSec.values()), perMsg };
}

// ------------------------------------------------------------------------------------------------- Redis của hubv

let redis: Redis | null = null;
export function hubvRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.VERIFY_REDIS_URL || hostUrls().REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
    redis.on('error', () => undefined);
  }
  return redis;
}
export async function closeChaosRedis(): Promise<void> {
  await redis?.quit().catch(() => undefined);
  redis = null;
}

// ------------------------------------------------------------------------------------------------- đích điều khiển được

export interface SinkRequest {
  at: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Đặt hành vi của sink cho MỘT path (đích "chết" = fail, "chậm" = delayMs); `{}` = bình thường. */
export async function sinkMode(path: string, mode: { mode?: 'fail'; delayMs?: number }): Promise<void> {
  const r = await fetch(`${SINK}/_mode?path=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify(mode) });
  expect(r.ok, `sink PUT /_mode ${path} → ${r.status}`);
}

/** Xoá sổ request của sink (sink giữ tối đa 5000, cũ bị đẩy ra) — hubv chỉ một phiên dùng một lúc (C8). */
export async function sinkReset(): Promise<void> {
  await fetch(`${SINK}/_requests`, { method: 'DELETE' });
}

export async function sinkRequests(path: string): Promise<SinkRequest[]> {
  const r = await fetch(`${SINK}/_requests?path=${encodeURIComponent(path)}`);
  expect(r.ok, `sink GET /_requests → ${r.status}`);
  return (await r.json()) as SinkRequest[];
}
