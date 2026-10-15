/**
 * LH2 — lưới hứng `hub-hooks` (SPEC-hub-sap §4 + ĐÍNH CHÍNH H1/H2/H6/H10, ADR-214/215/216/222).
 *
 *   provider ─► Worker /hooks/:provider/:sourceKey
 *     ├─ chuyển tiếp hub (timeout CATCHNET_FORWARD_TIMEOUT_MS, ký header lưới mode=forward)
 *     │    hub trả lời rõ ràng ─► trả NGUYÊN cho provider, KHÔNG ghi D1
 *     │    hub vắng (timeout / lỗi mạng / 5xx không outcome / `unavailable`) ─► hứng:
 *     │        source có trong sources_sync + method được hứng + dưới trần ─► ghi D1 ─► ack "đã nhận" của source
 *     │        còn lại (key lạ, GET/HEAD, vượt trần, D1 lỗi) ─► 503 (KHÔNG 2xx khi chưa ghi bền — BB-3)
 *     └─ cron mỗi phút: phát lại ≤ CATCHNET_REPLAY_BATCH dòng vào chính /hooks/* (mode=replay)
 *
 * Worker KHÔNG giữ secret của provider và KHÔNG verify chữ ký provider (ADR-214): verify chỉ ở hub.
 */
import { forwardDecision, nextAttemptAt, outcomeOf, replayDecision, retryAfterMs, type HubReply } from './classify';
import { loadConfig, MAX_BODY_BYTES, type Config, type Env } from './config';
import { passThrough, storableHeaders } from './headers';
import { catchnetHeaders, constantTimeEqual, rawTargetOf, requestTarget, type CatchnetMode } from './sign';
import {
  deleteRow,
  deleteSource,
  dueRows,
  finishResync,
  getSource,
  insertCaught,
  markRetry,
  moveDead,
  purgeDead,
  stats,
  upsertSourceStmt,
  type InboxRow,
  type SourceInput,
  type SourceSync,
} from './store';
import { ulid } from './ulid';

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  log: (event, fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), proc: 'catchnet', event, ...fields })),
};

/** Khuôn path giống nginx EG1 (`EG:SOURCE_KEY_RE`) và route hub. */
const HOOK_RE = /^\/hooks\/([a-z0-9-]{1,64})\/([A-Za-z0-9_-]{1,64})$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_RE = /^[a-z0-9-]{1,64}$/;
/** H6: method được phép khai trong `catch_methods`. HEAD không bao giờ. GET chỉ khi source khai GET là sự kiện. */
const CATCHABLE = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'GET']);
const REPLAY_CONCURRENCY = 5;
/** Mạch "hub chết" trong isolate (§4.1): sau timeout/lỗi mạng, bỏ qua chuyển tiếp ≤ 30s — khỏi bắt provider chờ 4s mỗi lần. */
export const CIRCUIT_MS = 30_000;

const circuit = { openUntil: 0 };
export function resetCircuit(): void {
  circuit.openUntil = 0;
}

const json = (obj: unknown, status: number, extra?: Record<string, string>) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

/** Chưa ghi bền -> 503 để provider tự gửi lại (BB-3: không 2xx trước lần ghi bền đầu tiên). */
const unavailable = (reason: string) =>
  json(
    {
      error: 'service_unavailable',
      message: 'The service is temporarily unavailable.',
      fix: 'Retry later; webhook providers retry 5xx by themselves.',
      reason,
    },
    503,
    { 'retry-after': '30' },
  );

function validIp(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(t)) return t.split('.').every((p) => Number(p) <= 255) ? t : null;
  return /^[0-9a-fA-F:.]{2,45}$/.test(t) && t.includes(':') ? t : null;
}

interface HubCall {
  id: string;
  receivedAt: number;
  clientIp: string;
  mode: CatchnetMode;
  method: string;
  rawTarget: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Gọi hub: ký ĐÚNG target đưa vào fetch (T-7), header lưới đặt bằng `set` (mỗi header một giá trị). */
async function callHub(cfg: Config, deps: Deps, c: HubCall): Promise<Response> {
  const { url, target } = requestTarget(cfg.hubOrigin!, c.rawTarget);
  const hasBody = c.method !== 'GET' && c.method !== 'HEAD';
  const sent = hasBody ? c.body : new Uint8Array(0);
  const headers = new Headers(c.headers);
  if (cfg.forwardSecret) {
    const sig = await catchnetHeaders(cfg.forwardSecret, {
      id: c.id,
      receivedAt: c.receivedAt,
      clientIp: c.clientIp,
      mode: c.mode,
      method: c.method,
      target,
      body: sent,
    });
    for (const [k, v] of Object.entries(sig)) headers.set(k, v);
  }
  return deps.fetch(url, {
    method: c.method,
    headers,
    body: hasBody ? sent : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(cfg.forwardTimeoutMs),
  });
}

function ackResponse(src: SourceSync): Response {
  const noBody = src.ack_status === 204 || src.ack_status === 205 || src.ack_body === null;
  const headers: Record<string, string> = {};
  if (!noBody) headers['content-type'] = src.ack_type || 'application/json';
  return new Response(noBody ? null : src.ack_body, { status: src.ack_status, headers });
}

/** H6 + §4.3: có hứng request này không. */
export function catchable(src: SourceSync | null, provider: string, method: string): boolean {
  if (!src || src.provider !== provider) return false;
  if (method === 'HEAD') return false;
  const allowed = src.catch_methods.split(',').map((m) => m.trim().toUpperCase());
  return allowed.includes(method);
}

async function handleHook(req: Request, env: Env, cfg: Config, deps: Deps): Promise<Response> {
  const method = req.method.toUpperCase();
  const rawTarget = rawTargetOf(req.url);
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  const body = new Uint8Array(await req.arrayBuffer()); // bytes thô, KHÔNG parse (HMAC tính trên bytes)
  if (body.byteLength > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  if (!cfg.hubOrigin) {
    deps.log('catchnet_misconfigured', { what: 'HUB_ORIGIN_URL' });
    return unavailable('misconfigured');
  }

  const receivedAt = deps.now();
  const id = ulid(receivedAt);
  const clientIp = validIp(req.headers.get('cf-connecting-ip')) ?? '0.0.0.0';
  const headers = storableHeaders(req.headers);
  const call: HubCall = { id, receivedAt, clientIp, mode: 'forward', method, rawTarget, headers, body };

  let reply: HubReply = { status: null, outcome: null };
  let res: Response | null = null;
  if (receivedAt >= circuit.openUntil) {
    try {
      res = await callHub(cfg, deps, call);
      reply = { status: res.status, outcome: outcomeOf(res.headers) };
    } catch (e) {
      circuit.openUntil = deps.now() + CIRCUIT_MS;
      deps.log('catchnet_hub_unreachable', { id, error: (e as Error)?.name ?? 'Error' });
    }
  }
  if (res && forwardDecision(reply) === 'pass') return passThrough(res);
  if (res) await res.body?.cancel().catch(() => undefined);

  // ---- Hub vắng: hứng nếu được, không thì 503.
  const m = HOOK_RE.exec(rawTarget.split('?')[0]);
  if (!m) return unavailable('hub_unavailable');
  if (!cfg.forwardSecret) {
    deps.log('catchnet_misconfigured', { what: 'CATCHNET_FORWARD_SECRET' }); // không ký được thì phát lại vô nghĩa
    return unavailable('hub_unavailable');
  }
  const [, provider, sourceKey] = m;
  let src: SourceSync | null;
  try {
    src = await getSource(env.DB, sourceKey);
  } catch (e) {
    deps.log('catchnet_d1_error', { id, op: 'getSource', error: String((e as Error)?.message ?? e) });
    return unavailable('store_failed');
  }
  if (!catchable(src, provider, method)) return unavailable('hub_unavailable');
  try {
    const ok = await insertCaught(
      env.DB,
      { id, sourceKey, provider, method, target: rawTarget, headers, body, clientIp, receivedAt },
      { maxRows: cfg.maxRows, maxPerKey: cfg.maxPerKey },
    );
    if (!ok) {
      deps.log('catchnet_overflow', { sourceKey, maxRows: cfg.maxRows, maxPerKey: cfg.maxPerKey });
      return unavailable('overflow');
    }
  } catch (e) {
    deps.log('catchnet_d1_error', { id, op: 'insert', error: String((e as Error)?.message ?? e) });
    return unavailable('store_failed');
  }
  deps.log('catchnet_caught', { id, sourceKey, provider, method, status: reply.status, bytes: body.byteLength });
  return ackResponse(src!);
}

// ------------------------------------------------------------------ phát lại

async function replayOne(row: InboxRow, env: Env, cfg: Config, deps: Deps): Promise<'absent' | 'ok'> {
  const now = deps.now();
  if (now - row.received_at > cfg.retentionMs) {
    // Hub cũng bỏ header lưới quá hạn -> phát lại thành "gọi thẳng" và trượt cửa sổ chữ ký: dừng ở đây.
    await moveDead(env.DB, row.id, row.attempts, 'expired', now, row.last_status, row.last_error);
    deps.log('catchnet_dead', { id: row.id, reason: 'expired' });
    return 'ok';
  }
  const attempts = row.attempts + 1;
  let reply: HubReply = { status: null, outcome: null };
  let retryAfter: number | null = null;
  let error: string | null = null;
  try {
    const res = await callHub(cfg, deps, {
      id: row.id,
      receivedAt: row.received_at,
      clientIp: row.client_ip,
      mode: 'replay',
      method: row.method,
      rawTarget: row.target,
      headers: JSON.parse(row.headers_json) as Record<string, string>,
      body: row.body,
    });
    reply = { status: res.status, outcome: outcomeOf(res.headers) };
    retryAfter = retryAfterMs(res.headers, now);
    await res.body?.cancel().catch(() => undefined);
  } catch (e) {
    error = (e as Error)?.name ?? 'Error';
    circuit.openUntil = deps.now() + CIRCUIT_MS;
  }
  const act = replayDecision(reply, attempts);
  if (act.kind === 'done') {
    await deleteRow(env.DB, row.id);
    deps.log('catchnet_replayed', { id: row.id, status: reply.status, outcome: reply.outcome, attempts });
    return 'ok';
  }
  if (act.kind === 'dead') {
    await moveDead(env.DB, row.id, attempts, act.reason, now, reply.status, error);
    deps.log('catchnet_dead', { id: row.id, reason: act.reason, status: reply.status, outcome: reply.outcome });
    return 'ok';
  }
  const nextAt = nextAttemptAt(now, attempts, retryAfter);
  await markRetry(env.DB, row.id, attempts, nextAt, reply.status, error);
  deps.log('catchnet_retry', { id: row.id, status: reply.status, outcome: reply.outcome, attempts, inMs: nextAt - now });
  return act.absent ? 'absent' : 'ok';
}

/**
 * Một lượt cron (ADR-216): ≤ `replayBatch` dòng tới hạn, song song ≤ 5, DỪNG lô khi thấy hub vắng (dòng chưa gửi giữ
 * nguyên `next_at`, lượt sau thử lại) — không dội hub đang chết, không đốt subrequest. Dọn `inbox_dead` mỗi giờ.
 */
export async function runReplay(env: Env, deps: Deps = defaultDeps, scheduledTime?: number): Promise<{ sent: number; stopped: boolean }> {
  const cfg = loadConfig(env);
  const now = deps.now();
  if (new Date(scheduledTime ?? now).getUTCMinutes() === 0) {
    const n = await purgeDead(env.DB, now - cfg.retentionMs);
    if (n > 0) deps.log('catchnet_dead_purged', { n });
  }
  if (!cfg.hubOrigin || !cfg.forwardSecret) {
    deps.log('catchnet_misconfigured', { what: !cfg.hubOrigin ? 'HUB_ORIGIN_URL' : 'CATCHNET_FORWARD_SECRET', in: 'replay' });
    return { sent: 0, stopped: true };
  }
  const rows = await dueRows(env.DB, now, cfg.replayBatch);
  let sent = 0;
  for (let i = 0; i < rows.length; i += REPLAY_CONCURRENCY) {
    const chunk = rows.slice(i, i + REPLAY_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((r) =>
        replayOne(r, env, cfg, deps).catch((e) => {
          deps.log('catchnet_d1_error', { id: r.id, op: 'replay', error: String((e as Error)?.message ?? e) });
          return 'ok' as const;
        }),
      ),
    );
    sent += chunk.length;
    if (results.includes('absent')) return { sent, stopped: true };
  }
  return { sent, stopped: false };
}

// ------------------------------------------------------------------ đồng bộ sources_sync (§4.5)

function parseSource(key: string, v: unknown): SourceInput | string {
  if (!KEY_RE.test(key)) return 'source_key sai khuôn';
  if (typeof v !== 'object' || v === null) return 'body phải là object';
  const o = v as Record<string, unknown>;
  const provider = o.provider;
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) return 'provider sai khuôn';
  const ackStatus = o.ackStatus;
  if (typeof ackStatus !== 'number' || !Number.isInteger(ackStatus) || ackStatus < 200 || ackStatus > 299) {
    return 'ackStatus phải là 2xx (ack "đã nhận")';
  }
  const ackType = o.ackType ?? null;
  if (ackType !== null && (typeof ackType !== 'string' || ackType.length > 200)) return 'ackType sai';
  const ackBody = o.ackBody ?? null;
  if (ackBody !== null && (typeof ackBody !== 'string' || ackBody.length > 4096)) return 'ackBody phải là chuỗi ≤ 4096';
  const rawMethods = o.catchMethods ?? ['POST'];
  if (!Array.isArray(rawMethods) || rawMethods.length === 0) return 'catchMethods phải là mảng khác rỗng';
  const methods = [...new Set(rawMethods.map((m) => String(m).toUpperCase()))];
  if (!methods.every((m) => CATCHABLE.has(m))) return 'catchMethods chỉ nhận POST/PUT/PATCH/DELETE/GET (HEAD không bao giờ, H6)';
  return { key, provider, ackStatus, ackType: ackType as string | null, ackBody: ackBody as string | null, catchMethods: methods.join(',') };
}

async function handleAdmin(req: Request, url: URL, env: Env, cfg: Config, deps: Deps): Promise<Response> {
  if (!cfg.adminToken) return json({ error: 'admin_disabled' }, 503);
  const auth = req.headers.get('authorization') ?? '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!constantTimeEqual(given, cfg.adminToken)) return json({ error: 'unauthorized' }, 401);

  const now = deps.now();
  const one = /^\/_admin\/sources\/([^/]+)$/.exec(url.pathname);
  if (url.pathname === '/_admin/sources/resync' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { syncId?: unknown; sources?: unknown; final?: unknown } | null;
    if (!b || typeof b.syncId !== 'string' || !KEY_RE.test(b.syncId)) return json({ error: 'invalid', message: 'syncId sai khuôn' }, 422);
    if (!Array.isArray(b.sources) || b.sources.length > 100) return json({ error: 'invalid', message: 'sources: mảng ≤ 100' }, 422);
    const parsed: SourceInput[] = [];
    for (const s of b.sources) {
      const p = parseSource(String((s as { key?: unknown })?.key ?? ''), s);
      if (typeof p === 'string') return json({ error: 'invalid', message: p }, 422);
      parsed.push(p);
    }
    if (parsed.length) await env.DB.batch(parsed.map((p) => upsertSourceStmt(env.DB, p, now, b.syncId as string)));
    const removed = b.final === true ? await finishResync(env.DB, b.syncId) : 0;
    return json({ upserted: parsed.length, removed }, 200);
  }
  if (one && one[1] !== 'resync') {
    const key = decodeURIComponent(one[1]);
    if (req.method === 'PUT') {
      const p = parseSource(key, await req.json().catch(() => null));
      if (typeof p === 'string') return json({ error: 'invalid', message: p }, 422);
      await upsertSourceStmt(env.DB, p, now, null).run();
      return json({ ok: true }, 200);
    }
    if (req.method === 'DELETE') return json({ deleted: await deleteSource(env.DB, key) }, 200);
    return json({ error: 'method_not_allowed' }, 405);
  }
  if (url.pathname === '/_admin/stats' && req.method === 'GET') return json(await stats(env.DB), 200);
  return json({ error: 'not_found' }, 404);
}

export async function handleFetch(req: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const cfg = loadConfig(env);
  const path = rawTargetOf(req.url).split('?')[0];
  try {
    if (/^\/hooks(\/|$)/i.test(path)) return await handleHook(req, env, cfg, deps);
    if (path === '/_health') return json({ ok: true }, 200);
    if (path.startsWith('/_admin/')) return await handleAdmin(req, new URL(req.url), env, cfg, deps);
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    deps.log('catchnet_error', { error: String((e as Error)?.message ?? e) });
    return unavailable('internal'); // chưa ghi bền -> không 2xx
  }
}

