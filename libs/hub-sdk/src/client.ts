import { inspect } from 'util';
import { challengeResponse, verifyWebhook } from './webhook';

/**
 * SDK Node cho service dùng hub (SPEC §4.11). `fetch` của Node ≥ 18, không phụ thuộc thư viện ngoài.
 * Key thô KHÔNG BAO GIỜ xuất hiện trong `console.log(client)`, `JSON.stringify(client)` hay message của lỗi.
 */
export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly body?: unknown,
  ) {
    super(message ?? `Hub trả HTTP ${status} (${code})`);
    this.name = 'HubError';
  }
}

export interface HubConnection {
  baseUrl: string;
  project: string;
  apiKey: string;
}

const KEY_RE = /^hk_(test|live)_[A-Za-z0-9_-]{8,128}$/;

/** `hubs://<key>@<host>/<project>` (https) | `hub://…` (http). Sai -> HubError 0 `invalid_connection_string`. */
export function parseConnectionString(cs: string): HubConnection {
  const m = /^(hubs?):\/\/([^@/\s]+)@([^/\s]+)\/([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(String(cs ?? '').trim());
  if (!m || !KEY_RE.test(decodeURIComponent(m[2]))) {
    throw new HubError(0, 'invalid_connection_string', 'Connection string phải có dạng hubs://hk_<env>_…@<host>/<project>');
  }
  return { baseUrl: `${m[1] === 'hubs' ? 'https' : 'http'}://${m[3]}`, project: m[4], apiKey: decodeURIComponent(m[2]) };
}

/** `hk_live_abcd…wxyz` -> `hk_live_••••wxyz`. */
export function maskKey(key: string): string {
  const m = /^(hk_(?:test|live)_)/.exec(key);
  return `${m ? m[1] : ''}••••${key.slice(-4)}`;
}

export interface PollOptions {
  after?: string;
  limit?: number;
  types?: string[];
  status?: 'failed';
  endpointId?: string;
  wait?: number;
}
export interface HubEvent {
  id: string;
  /** Cursor polling (thứ tự COMMIT) — truyền lại làm `after`. Không phải `seq` của dashboard (R2-3). */
  cursor: string;
  type: string;
  source: string;
  sourceId: string | null;
  subject: string | null;
  data: any;
  normalized: boolean;
  correlationId: string;
  occurredAt: string;
  receivedAt: string;
}
export interface Endpoint {
  id: string;
  name: string;
  url: string | null;
  verification: 'PENDING' | 'VERIFIED' | 'FAILED';
  verificationError: string | null;
  signingSecret?: string;
}
export interface Subscription {
  id: string;
  name: string;
  endpointId: string;
  eventTypes: string[];
  sourceIds: string[];
  /** MS-P2-1: sourceKey tương ứng sourceIds (để service so mà không cần manage:sources). */
  sourceKeys?: string[];
  isActive: boolean;
}
export interface EnsureEndpointInput {
  name: string;
  url: string;
  eventTypes: string[];
  sourceIds?: string[];
  /** MS-P2-1: ghim nguồn theo sourceKey (vd `src_sepay_main`) — chỉ nhận sự kiện từ ĐÚNG các source này. */
  sourceKeys?: string[];
  /** Tắt mọi subscription KHÁC đang bật của endpoint này (vd sub cũ chưa ghim nguồn). */
  exclusive?: boolean;
  signingSecret?: string;
}

type FetchLike = (url: string, init?: any) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export class HubClient {
  readonly baseUrl: string;
  readonly project: string;
  /** Private field (#): không liệt kê, không vào JSON, không lộ qua util.inspect. */
  readonly #key: string;
  readonly #fetch: FetchLike;

  constructor(connectionString: string, opts: { fetch?: FetchLike } = {}) {
    const c = parseConnectionString(connectionString);
    this.baseUrl = c.baseUrl;
    this.project = c.project;
    this.#key = c.apiKey;
    this.#fetch = opts.fetch ?? ((globalThis as any).fetch as FetchLike);
  }

  toJSON() {
    return { baseUrl: this.baseUrl, project: this.project, apiKey: maskKey(this.#key) };
  }

  [inspect.custom]() {
    return `HubClient ${JSON.stringify(this.toJSON())}`;
  }

  /** Kiểm kết nối: `{project, serviceName, scopes}`. */
  me(): Promise<{ project: { slug: string; name: string; environment: string }; serviceName: string; scopes: string[] }> {
    return this.request('GET', '/me');
  }

  /** 202 `{rawEventId, duplicate:false}` khi hub đã COMMIT; gửi lại cùng idempotencyKey -> `{duplicate:true}`. */
  publish(type: string, data: Record<string, unknown>, opts: { idempotencyKey: string; subject?: string }) {
    return this.request<{ eventId?: null; rawEventId?: string; duplicate: boolean }>('POST', '/events', {
      type,
      data,
      idempotencyKey: opts.idempotencyKey,
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    });
  }

  /** Polling (A): `after` = `nextCursor` (hoặc `event.cursor`) lần trước, CHUỖI. Rỗng -> `nextCursor` giữ nguyên `after`. */
  poll(opts: PollOptions = {}): Promise<{ events: HubEvent[]; nextCursor: string }> {
    const q = new URLSearchParams();
    if (opts.after !== undefined) q.set('after', String(opts.after));
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.types?.length) q.set('types', opts.types.join(','));
    if (opts.status) q.set('status', opts.status);
    if (opts.endpointId) q.set('endpointId', opts.endpointId);
    if (opts.wait !== undefined) q.set('wait', String(opts.wait));
    const qs = q.toString();
    return this.request('GET', `/events${qs ? `?${qs}` : ''}`);
  }

  readonly endpoints = {
    list: (): Promise<Endpoint[]> => this.request('GET', '/endpoints'),
    create: (input: { name: string; url: string; signingSecret?: string }): Promise<Endpoint> => this.request('POST', '/endpoints', input),
    /** Chạy lại challenge. Kèm `signingSecret` = xoay secret có chứng minh (chỉ lưu khi endpoint verify được bằng secret mới). */
    verify: (id: string, opts: { signingSecret?: string } = {}): Promise<{ verification: Endpoint['verification']; verificationError: string | null; secretRotated?: boolean }> =>
      this.request('POST', `/endpoints/${encodeURIComponent(id)}/verify`, opts.signingSecret ? { signingSecret: opts.signingSecret } : undefined),
    /**
     * Idempotent (gọi mỗi lần service khởi động): tìm endpoint theo `url`; chưa có thì tạo; chưa VERIFIED thì
     * `/verify`; rồi đảm bảo có subscription phủ `eventTypes` (+ `sourceIds`). Không VERIFIED được -> HubError
     * `endpoint_not_verified` (kèm lý do) để caller thử lại.
     */
    ensure: async (input: EnsureEndpointInput): Promise<{ endpoint: Endpoint; subscription: Subscription; created: boolean }> => {
      const url = new URL(input.url).toString();
      let endpoint = (await this.endpoints.list()).find((e) => e.url === url);
      const created = !endpoint;
      if (!endpoint) {
        endpoint = await this.endpoints.create({ name: input.name, url, ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}) });
      } else if (input.signingSecret) {
        // MS-R4: endpoint đã có nhưng secret của service có thể đã đổi — luôn chứng minh lại bằng secret hiện tại
        // (hub chỉ lưu khi khớp). Không làm vậy thì hub ký secret cũ -> service 401 -> DEAD mà log vẫn "VERIFIED".
        endpoint = { ...endpoint, ...(await this.endpoints.verify(endpoint.id, { signingSecret: input.signingSecret })) };
      } else if (endpoint.verification !== 'VERIFIED') {
        endpoint = { ...endpoint, ...(await this.endpoints.verify(endpoint.id)) };
      }
      if (endpoint.verification !== 'VERIFIED') {
        throw new HubError(409, 'endpoint_not_verified', `Endpoint ${url} chưa VERIFIED (${endpoint.verificationError ?? 'không rõ'})`);
      }
      const byKeys = !!input.sourceKeys?.length;
      const wanted = [...((byKeys ? input.sourceKeys : input.sourceIds) ?? [])].sort().join(',');
      const sourcesOf = (s: Subscription) => [...((byKeys ? s.sourceKeys : s.sourceIds) ?? [])].sort().join(',');
      const subs = await this.subscriptions.list();
      let subscription = subs.find(
        (s) => s.endpointId === endpoint!.id && s.isActive && input.eventTypes.every((t) => s.eventTypes.includes(t)) && sourcesOf(s) === wanted,
      );
      if (!subscription) {
        subscription = await this.subscriptions.create({
          endpointId: endpoint.id,
          name: input.name,
          eventTypes: input.eventTypes,
          ...(input.sourceIds?.length ? { sourceIds: input.sourceIds } : {}),
          ...(byKeys ? { sourceKeys: input.sourceKeys } : {}),
        });
      }
      if (input.exclusive) {
        for (const s of subs) {
          if (s.endpointId === endpoint.id && s.isActive && s.id !== subscription.id) await this.subscriptions.update(s.id, { isActive: false });
        }
      }
      return { endpoint, subscription, created };
    },
  };

  readonly subscriptions = {
    list: (): Promise<Subscription[]> => this.request('GET', '/subscriptions'),
    create: (input: { endpointId: string; name: string; eventTypes: string[]; sourceIds?: string[]; sourceKeys?: string[] }): Promise<Subscription> =>
      this.request('POST', '/subscriptions', input),
    update: (id: string, patch: { isActive: boolean }): Promise<Subscription> => this.request('PATCH', `/subscriptions/${encodeURIComponent(id)}`, patch),
  };

  /** Phía nhận: verify Standard Webhooks trên BYTES gốc. */
  verifyWebhook(rawBody: Buffer | string, headers: Record<string, unknown>, signingSecret: string): boolean {
    return verifyWebhook(rawBody, headers, signingSecret);
  }

  challengeResponse(body: unknown): { challenge: string } | null {
    return challengeResponse(body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res;
    try {
      res = await this.#fetch(`${this.baseUrl}/v1/p/${this.project}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e: any) {
      // Không chèn message gốc nguyên văn (có thể chứa header); chỉ mã lỗi mạng.
      throw new HubError(0, 'network_error', `Không gọi được hub ${this.baseUrl} (${e?.cause?.code ?? e?.code ?? e?.name ?? 'lỗi mạng'})`);
    }
    const text = await res.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const code = typeof parsed?.error === 'string' ? parsed.error : `http_${res.status}`;
      throw new HubError(res.status, code, `Hub trả HTTP ${res.status} (${code}) cho ${method} ${path.split('?')[0]}`, parsed);
    }
    return parsed as T;
  }
}

export function createHubClient(connectionString: string, opts?: { fetch?: FetchLike }): HubClient {
  return new HubClient(connectionString, opts);
}
