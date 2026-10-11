import { randomBytes } from 'crypto';
import { parseArgs } from 'util';
import { SAMPLE_TYPES, canonicalSample, isReservedType, toWebhookBody } from '@hub/common';
import { HubClient, HubError, HubEvent, maskKey, parseConnectionString } from './client';
import { signWebhook } from './webhook';

/**
 * DX3 (SPEC-dev-experience §4): CLI `hub` — `listen` (kéo bằng polling A, đẩy vào localhost, ký Standard Webhooks)
 * và `trigger` (DX3b). KHÔNG thêm hạ tầng server: listen chỉ là một client polling + ký phía client.
 * Chỉ đọc: không tạo delivery, không chạm endpoint/circuit breaker thật. Không retry (công cụ dev).
 *
 * Ghi chú đóng gói: `toWebhookBody` nạp từ `@hub/common` (luật Parity — cấm serializer thứ hai), nên CLI chạy trong
 * monorepo hoặc sau `npm i <đường dẫn libs/hub-sdk>` (symlink). Thư viện chính (`index`) vẫn không phụ thuộc runtime.
 */
type FetchLike = (url: string, init?: any) => Promise<any>;

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** fetch gọi hub (mặc định global fetch). */
  fetch?: FetchLike;
  /** fetch đẩy vào app local (mặc định global fetch). */
  forwardFetch?: FetchLike;
  /** Ctrl+C -> abort: dừng vòng poll, in tổng kết, mã 0. */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const USAGE = [
  'Usage:',
  '  hub listen --forward <url> [--types payment.*,repo.push] [--from latest|<cursor>]',
  '             [--secret whsec_…] [--allow-remote] [--url <connection string>]',
  '  hub trigger <type> [--data \'{"amount":50000}\'] [--url <connection string>]',
  '',
  'Connection string: --url, or env HUB_URL (hub://hk_test_…@localhost:4000/<project> | hubs://…@<host>/<project>).',
].join('\n');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);
const BACKOFF_MS = [1000, 2000, 5000];
export const FORWARD_TIMEOUT_MS = 10_000;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** `fix` của hub (DX1) nếu body lỗi có; không thì null. Không bao giờ in nguyên body (có thể dài/khó đọc). */
function fixOf(e: unknown): string | null {
  const b = (e as HubError)?.body as { fix?: unknown } | undefined;
  return typeof b?.fix === 'string' ? b.fix : null;
}

/** Trần chờ theo Retry-After (L-5): hub/proxy xin chờ lâu hơn thì vẫn thử lại sau 30s. */
export const MAX_RETRY_AFTER_MS = 30_000;
const MIN_RETRY_MS = 1000;
/** R2-L2: số lần thử `after=latest` trước khi bỏ cuộc (≈ 40 s với backoff 1/2/5 s). */
export const LATEST_MAX_ATTEMPTS = 10;

const describe = (he: HubError) => (he?.status ? `HTTP ${he.status}` : he?.code ?? 'error');

/**
 * Lỗi tạm thời (mất mạng, 5xx, 429) -> số ms chờ; lỗi khác -> null (thoát, in fix). 429/503 có Retry-After thì theo
 * nó (trần 30s), không thì bậc 1s -> 2s -> 5s.
 */
function retryDelayMs(he: HubError, attempt: number): number | null {
  const transient = he?.status === 0 || he?.status === 429 || he?.status >= 500;
  if (!transient) return null;
  // R2-L1: kẹp [1 s, 30 s] — `Retry-After: 0` của proxy không được biến thành vòng poll không nghỉ.
  if ((he.status === 429 || he.status === 503) && typeof he.retryAfter === 'number') {
    return Math.max(MIN_RETRY_MS, Math.min(he.retryAfter * 1000, MAX_RETRY_AFTER_MS));
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

export interface ForwardResult {
  status?: number;
  durationMs: number;
  /** ≤ 200 ký tự đầu body trả về (chỉ khi non-2xx). */
  bodySnippet?: string;
  error?: 'econnrefused' | 'timeout' | 'network';
  errorCode?: string;
}

/**
 * Đẩy MỘT event vào `forwardUrl`: body = `toWebhookBody(event)` (byte-identical với WebhookSender), header Standard
 * Webhooks ký bằng secret phiên, timeout 10s. Không retry.
 */
export async function forwardEvent(
  forwardUrl: string,
  event: HubEvent,
  secret: string,
  fetchImpl: FetchLike = (globalThis as any).fetch,
  timeoutMs = FORWARD_TIMEOUT_MS,
): Promise<ForwardResult> {
  const body = toWebhookBody(event);
  const start = Date.now();
  try {
    const res = await fetchImpl(forwardUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signWebhook(secret, event.id, body) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = res.status >= 200 && res.status < 300 ? '' : await res.text().catch(() => '');
    return { status: res.status, durationMs: Date.now() - start, ...(text ? { bodySnippet: oneLine(text) } : {}) };
  } catch (e: any) {
    const code = e?.cause?.code ?? e?.code;
    if (code === 'ECONNREFUSED') return { durationMs: Date.now() - start, error: 'econnrefused' };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { durationMs: Date.now() - start, error: 'timeout' };
    return { durationMs: Date.now() - start, error: 'network', errorCode: String(code ?? e?.name ?? 'error') };
  }
}

/** Mặc định chỉ forward tới máy mình — tránh lỡ tay đẩy dữ liệu project sang chỗ lạ (§4.3 luật). */
export function isLocalForward(u: URL): boolean {
  return LOCAL_HOSTS.has(u.hostname.toLowerCase());
}

/** Dựng client từ `--url`/HUB_URL; lỗi -> in hướng dẫn (KHÔNG in lại chuỗi, có thể chứa key) và trả mã 2. */
function connect(values: { url?: string }, io: CliIO, fetchImpl: FetchLike): { client: HubClient; masked: string } | number {
  const cs = values.url ?? io.env.HUB_URL;
  if (!cs) {
    io.err('Missing connection string. Set HUB_URL=hub://hk_test_…@localhost:4000/<project> (or pass --url). Get one in the console: Project → Keys.');
    return 2;
  }
  try {
    const c = parseConnectionString(cs);
    return { client: new HubClient(cs, { fetch: fetchImpl }), masked: maskKey(c.apiKey) };
  } catch {
    io.err('Invalid connection string. Expected hub://hk_<env>_…@<host>/<project> (http) or hubs://… (https).');
    return 2;
  }
}

function printHubError(io: CliIO, what: string, e: unknown) {
  const he = e as HubError;
  io.err(`${what} failed: ${he?.code ?? 'error'}${he?.status ? ` (HTTP ${he.status})` : ''}`);
  const fix = fixOf(e);
  if (fix) io.err(`  fix: ${fix}`);
  else if (he?.status === 401) io.err('  fix: Check HUB_URL — the key may be wrong or revoked. Create a new key in the console (Project → Keys).');
}

async function listen(args: string[], io: CliIO): Promise<number> {
  let values: Record<string, any>;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        forward: { type: 'string', short: 'f' },
        types: { type: 'string' },
        from: { type: 'string', default: 'latest' },
        secret: { type: 'string' },
        'allow-remote': { type: 'boolean', default: false },
        url: { type: 'string' },
      },
      strict: true,
    }));
  } catch (e: any) {
    io.err(`${e?.message ?? 'Invalid arguments'}\n${USAGE}`);
    return 2;
  }
  if (!values.forward) {
    io.err(`Missing --forward <url>, e.g. --forward http://localhost:3000/webhooks\n${USAGE}`);
    return 2;
  }
  let target: URL;
  try {
    target = new URL(values.forward);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('protocol');
  } catch {
    io.err(`--forward must be an http(s) URL, e.g. http://localhost:3000/webhooks`);
    return 2;
  }
  if (!isLocalForward(target) && !values['allow-remote']) {
    io.err(
      `Refusing to forward to ${target.host}: hub listen only forwards to localhost, 127.0.0.1, ::1 or host.docker.internal by default.\n` +
        `  fix: forward to your local app, or pass --allow-remote if you really mean to send this project's events to ${target.host}.`,
    );
    return 2;
  }
  if (values.from !== 'latest' && !/^\d{1,19}$/.test(values.from)) {
    io.err('--from must be "latest" or a cursor (the number printed as "Last cursor").');
    return 2;
  }

  const signal = io.signal;
  const baseFetch: FetchLike = io.fetch ?? (globalThis as any).fetch;
  // Ctrl+C phải cắt cả long-poll 20s đang chờ.
  const hubFetch: FetchLike = (url, init) => baseFetch(url, { ...init, ...(signal ? { signal } : {}) });
  const conn = connect(values, io, hubFetch);
  if (typeof conn === 'number') return conn;
  const { client, masked } = conn;

  let me;
  try {
    me = await client.me();
  } catch (e) {
    printHubError(io, 'Connecting to hub', e);
    return 1;
  }
  if (!me.scopes?.includes('read:events')) {
    io.err(`This key lacks scope "read:events" (has: ${(me.scopes ?? []).join(', ') || 'none'}).`);
    io.err('  fix: Create a key with scope "read:events" in the console (Project → Keys), or ask the hub admin.');
    return 1;
  }
  io.out(`Connected to project "${me.project.slug}" as service "${me.serviceName}" (key ${masked})`);

  let secret: string = values.secret ?? io.env.HUB_LISTEN_SECRET ?? '';
  if (!secret) {
    secret = `whsec_${randomBytes(24).toString('base64')}`;
    io.out(`Your local signing secret: ${secret} (set HUB_LISTEN_SECRET to keep it stable)`);
  }

  const types = values.types ? String(values.types).split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const sleep = io.sleep ?? defaultSleep;
  let cursor: string;
  if (values.from === 'latest') {
    // M-1: hub có thể trả 503 khi đang cấp cursor cho event tồn — thử lại có backoff, không thoát.
    let attempt = 0;
    for (;;) {
      try {
        cursor = (await client.poll({ after: 'latest' })).nextCursor;
        break;
      } catch (e) {
        if (signal?.aborted) return 0;
        const ms = retryDelayMs(e as HubError, attempt);
        if (ms === null) {
          printHubError(io, 'Reading latest cursor', e);
          return 1;
        }
        attempt++;
        if (attempt >= LATEST_MAX_ATTEMPTS) {
          // R2-L2: không treo mãi — báo rõ và đưa fix (của hub nếu có).
          io.err(`Reading latest cursor gave up after ${attempt} attempts (${describe(e as HubError)}).`);
          io.err(`  fix: ${fixOf(e) ?? 'Check that the hub is up (GET /health) and retry later'}; or start from a known position with --from <cursor> (e.g. the "Last cursor" of a previous run).`);
          return 1;
        }
        io.err(`${hhmmss()}  hub busy (${describe(e as HubError)}) — retrying in ${ms / 1000}s`);
        await sleep(ms, signal);
        if (signal?.aborted) return 0;
      }
    }
  } else cursor = values.from;
  io.out(`Ready. Forwarding ${types ? types.join(',') : 'all readable'} events to ${target.toString()} from cursor ${cursor}. Ctrl+C to stop.`);

  const fwdFetch = io.forwardFetch ?? (globalThis as any).fetch;
  let forwarded = 0;
  let failed = 0;
  let backoff = 0;
  let exit = 0;
  while (!signal?.aborted) {
    let page: { events: HubEvent[]; nextCursor: string };
    try {
      page = await client.poll({ after: cursor, types, wait: 20, limit: 100 });
      backoff = 0;
    } catch (e: any) {
      if (signal?.aborted) break;
      const he = e as HubError;
      const ms = retryDelayMs(he, backoff);
      if (ms !== null) {
        backoff++;
        const what = he?.status === 429 ? 'rate limited' : 'hub unavailable';
        io.err(`${hhmmss()}  ${what} (${describe(he)}) — retrying in ${ms / 1000}s`);
        await sleep(ms, signal);
        continue;
      }
      printHubError(io, 'Polling events', e);
      exit = 1;
      break;
    }
    for (const ev of page.events) {
      const r = await forwardEvent(target.toString(), ev, secret, fwdFetch);
      forwarded++;
      const head = `${hhmmss()}  ${ev.type}  ${ev.id}  →`;
      if (r.error === 'econnrefused') {
        failed++;
        io.err(`${head} Cannot reach ${target.toString()} — is your app running?`);
      } else if (r.error) {
        failed++;
        io.err(`${head} ${r.error === 'timeout' ? `timeout (no response in ${FORWARD_TIMEOUT_MS / 1000}s)` : `network error (${r.errorCode})`}`);
      } else if (r.status! >= 200 && r.status! < 300) {
        io.out(`${head} ${r.status} (${r.durationMs} ms)`);
      } else {
        failed++;
        io.err(`${head} ${r.status} (${r.durationMs} ms)${r.bodySnippet ? ` ${r.bodySnippet}` : ''}`);
      }
      // Không retry: cursor tiến kể cả khi local trả lỗi (§4.3 bước 5).
      cursor = ev.cursor;
    }
    cursor = page.nextCursor ?? cursor;
  }
  io.out(`Forwarded ${forwarded} events (${failed} failed). Last cursor: ${cursor}. Resume with --from ${cursor}`);
  return exit;
}

/** id ngắn, tăng theo thời gian, duy nhất mỗi lần gọi (idempotencyKey + providerTxnId của mẫu). */
const triggerId = () => `${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;

/**
 * DX3b (§4.4): `hub trigger <type> [--data '{…}']` — mẫu của catalog (kiểu chuẩn) ghép `--data`, rồi
 * `hub.publish` như mọi service: hub chạy validateCanonical + đường ingest bình thường (không lối tắt).
 */
async function trigger(args: string[], io: CliIO): Promise<number> {
  let values: Record<string, any>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: { data: { type: 'string' }, url: { type: 'string' } }, allowPositionals: true, strict: true }));
  } catch (e: any) {
    io.err(`${e?.message ?? 'Invalid arguments'}
${USAGE}`);
    return 2;
  }
  const type = positionals[0];
  if (!type || positionals.length > 1) {
    io.err(`Usage: hub trigger <type> [--data '{"amount":50000}']. Types with a built-in sample: ${SAMPLE_TYPES.join(', ')}`);
    return 2;
  }
  let extra: Record<string, unknown> = {};
  if (values.data !== undefined) {
    try {
      extra = JSON.parse(values.data);
    } catch {
      extra = undefined as any;
    }
    if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
      io.err(`--data must be a JSON object, e.g. --data '{"amount":50000}'`);
      return 2;
    }
  }
  const id = triggerId();
  const sample = canonicalSample(type, new Date(), id);
  if (!sample && isReservedType(type)) {
    io.err(`No sample for "${type}" (reserved namespace). Types with a built-in sample: ${SAMPLE_TYPES.join(', ')}`);
    return 2;
  }
  const conn = connect(values, io, io.fetch ?? (globalThis as any).fetch);
  if (typeof conn === 'number') return conn;
  const { client } = conn;
  try {
    const me = await client.me();
    if (!me.scopes?.includes('publish:events')) {
      io.err(`This key lacks scope "publish:events" (has: ${(me.scopes ?? []).join(', ') || 'none'}).`);
      io.err('  fix: Create a key with scope "publish:events" in the console (Project → Keys), or ask the hub admin.');
      return 1;
    }
    const r = await client.publish(type, { ...(sample ?? {}), ...extra }, { idempotencyKey: `trigger-${id}` });
    io.out(`Published ${type} (rawEventId ${r.rawEventId ?? '-'}${r.duplicate ? ', duplicate' : ''}). It reaches subscribers / hub listen after normalize.`);
    return 0;
  } catch (e) {
    const b = (e as HubError)?.body as { field?: unknown } | undefined;
    printHubError(io, `Publishing ${type}`, e);
    if (typeof b?.field === 'string') io.err(`  field: ${b.field}`);
    return 1;
  }
}

/** `hub <command> …` -> mã thoát. Không bao giờ in key thô (connection string chỉ được parse, không echo). */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'listen') return listen(rest, io);
  if (cmd === 'trigger') return trigger(rest, io);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    io.out(USAGE);
    return cmd ? 0 : 2;
  }
  io.err(`Unknown command "${cmd}".\n${USAGE}`);
  return 2;
}
