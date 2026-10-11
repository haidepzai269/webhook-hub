// SK2 (SPEC-shop-ket-noi-project §4, ADR-155, ADR-160): cài đặt kết nối — `shop.settings` thắng env; env cũ là mặc định (cách A).
import { createHash } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { aesGcmDecrypt, aesGcmEncrypt, timingSafeCompare } from '@hub/crypto';
import { createHubClient, HubClient, parseConnectionString } from '@hub/sdk';
import { HubRegistration } from './hub-registration';
/** Trường cài đặt -> biến env cũ. Giá trị đã gộp (DB thắng env) trả về DƯỚI DẠNG env để payos/VietQR/main không đổi. */
export const FIELDS = {
  hubConnectionUrl: 'HUB_URL', paymentSourceKeys: 'SHOP_PAYMENT_SOURCE_KEYS', payosClientId: 'PAYOS_CLIENT_ID', payosApiKey: 'PAYOS_API_KEY',
  payosChecksumKey: 'PAYOS_CHECKSUM_KEY', bankCode: 'SHOP_BANK_CODE', bankAccount: 'SHOP_BANK_ACCOUNT', bankAccountName: 'SHOP_BANK_ACCOUNT_NAME',
} as const;
export type Field = keyof typeof FIELDS;
const ALL = Object.keys(FIELDS) as Field[];
const SECRET: Field[] = ['hubConnectionUrl', 'payosClientId', 'payosApiKey', 'payosChecksumKey']; // cột *_encrypted, ciphertext `iv:tag:data`
export type SettingsRow = { [K in Exclude<Field, 'paymentSourceKeys'>]: string | null } & { paymentSourceKeys: string[]; updatedAt: Date };
export type Input = Partial<Record<Field, string | string[] | null>>;
type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
export interface Resolved { env: NodeJS.ProcessEnv; sources: Record<Field, 'db' | 'env' | 'none'>; updatedAt: Date | null; unreadable?: boolean; degraded?: boolean }
type Out = { status: number; body: object };
type Store = { load(): Promise<SettingsRow | null>; save(d: Partial<SettingsRow>): Promise<unknown> };
export const sourceKeysOf = (env: NodeJS.ProcessEnv) => (env.SHOP_PAYMENT_SOURCE_KEYS || 'src_payos_main,src_sepay_main').split(',').map((k) => k.trim()).filter(Boolean);
/** `SHOP_SETTINGS_KEY` = 32 byte base64 (`openssl rand -base64 32`); thiếu/ngắn -> null (không lưu được bí mật). */
export const settingsKey = (env: NodeJS.ProcessEnv) => (env.SHOP_SETTINGS_KEY && Buffer.from(env.SHOP_SETTINGS_KEY, 'base64').length >= 32 ? env.SHOP_SETTINGS_KEY : null);
/** M-3 (ADR-160): MỘT bản chụp — dòng giải mã được: DB thắng mọi trường đã đặt; giải mã lỗi (khoá sai/thiếu): env cho MỌI trường, không lai. */
export function resolveSettings(row: SettingsRow | null, env: NodeJS.ProcessEnv, key: string | null): Resolved {
  const [out, sources, db] = [{ ...env }, {} as Resolved['sources'], {} as Partial<Record<Field, string>>];
  for (const [f, v] of ALL.map((f) => [f, f === 'paymentSourceKeys' ? row?.paymentSourceKeys?.join(',') || null : (row?.[f] ?? null)] as const)) {
    try { if (v) db[f] = SECRET.includes(f) ? aesGcmDecrypt(v, key ?? '') : v; } catch { return { ...resolveSettings(null, env, null), unreadable: true }; }
  }
  for (const f of ALL) [out[FIELDS[f]], sources[f]] = db[f] ? [db[f], 'db'] : [env[FIELDS[f]], env[FIELDS[f]] ? 'env' : 'none'];
  return { env: out, sources, updatedAt: row?.updatedAt ?? null };
}
/** GET /settings: bí mật chỉ `configured` + 4 ký tự cuối (bí mật < 12 ký tự: không lộ gì); HUB_URL: đuôi KEY + project + host. */
export function publicView(r: Resolved, canSave: boolean) {
  const fields: Record<string, object> = {};
  for (const f of ALL) {
    const v = r.env[FIELDS[f]] ?? '';
    fields[f] = !SECRET.includes(f) ? { source: r.sources[f], value: f === 'paymentSourceKeys' ? sourceKeysOf(r.env) : v || null } : { source: r.sources[f], configured: !!v, last4: v.length >= 12 ? v.slice(-4) : null };
  }
  try { const c = parseConnectionString(r.env.HUB_URL ?? ''); Object.assign(fields.hubConnectionUrl, { last4: c.apiKey.slice(-4), project: c.project, host: new URL(c.baseUrl).host }); }
  catch { /* chưa có / sai dạng: chỉ configured */ }
  return { fields, canSave, updatedAt: r.updatedAt };
}
/** Body PUT: chỉ trường được gửi; chuỗi trống = giữ nguyên; `clear: [field]` = xoá về env. Sai dạng -> {error, field}. */
export function parseInput(body: any): Input | { error: string; field: string } {
  const out: Input = {};
  for (const f of ALL) {
    const raw = body?.[f];
    if (f === 'paymentSourceKeys' && raw !== undefined) {
      const keys = (Array.isArray(raw) ? raw : String(raw).split(',')).map((k) => String(k).trim()).filter(Boolean);
      if (keys.length > 10 || keys.some((k) => !/^[A-Za-z0-9_-]{1,64}$/.test(k))) return { error: 'sourceKey chỉ gồm chữ, số, _ và - (tối đa 10)', field: f };
      if (keys.length) out[f] = keys;
    } else if (typeof raw === 'string' && raw.trim()) {
      if (raw.trim().length > 512) return { error: 'Giá trị quá dài', field: f };
      out[f] = raw.trim();
    }
  }
  if (typeof out.hubConnectionUrl === 'string' && !/^hubs?:\/\/hk_(test|live)_[A-Za-z0-9_-]{8,128}@[^/\s]+\/[a-z0-9][a-z0-9-]{0,62}\/?$/.test(out.hubConnectionUrl)) {
    return { error: 'Connection string phải có dạng hubs://hk_<env>_…@<host>/<project>', field: 'hubConnectionUrl' };
  }
  for (const f of Array.isArray(body?.clear) ? body.clear : []) if (ALL.includes(f)) out[f as Field] = null;
  return out;
}
const hostOf = (u: string) => { try { return new URL(/^hubs?:/.test(u) ? parseConnectionString(u).baseUrl : u).host.toLowerCase(); } catch { return ''; } };
/** M-2 (ADR-160): host hub được phép = host của `HUB_URL` env + `SHOP_ALLOWED_HUB_HOSTS` (phẩy). Host khác không nhận HUB_SIGNING_SECRET. */
export const hubHostAllowed = (u: string, env: NodeJS.ProcessEnv) => !!hostOf(u) && [hostOf(env.HUB_URL ?? ''), ...(env.SHOP_ALLOWED_HUB_HOSTS ?? '').toLowerCase().split(',').map((h) => h.trim())].includes(hostOf(u));
const hostFix = (u: string) => `Host hub ${hostOf(u) || '?'} không được phép — fix: dùng connection string cùng host với HUB_URL env của Shop, hoặc thêm host vào SHOP_ALLOWED_HUB_HOSTS trên Render`;
/** Store thật: một dòng `shop.settings` (id = 1), upsert. */
export const prismaStore = (db: PrismaClient): Store => ({
  load: () => db.shopSetting.findUnique({ where: { id: 1 } }) as Promise<SettingsRow | null>,
  save: (data: Partial<SettingsRow>) => db.shopSetting.upsert({ where: { id: 1 }, create: { ...data, id: 1 }, update: data }),
});
/** Cache trong bộ nhớ. DB lỗi lúc đọc -> env (`degraded`, cache tạm) để Shop vẫn bán; `reload()` (main, mỗi 60s khi degraded) hội tụ về DB. */
export class ShopSettings {
  private cache: Promise<Resolved> | null = null; private warned = false; degraded = false;
  constructor(private readonly store: Store, private readonly env: NodeJS.ProcessEnv, private readonly log: Log) {}
  get key() { return settingsKey(this.env); }
  private read = () => this.store.load().then((row) => this.loaded(resolveSettings(row, this.env, this.key)));
  private loaded(r: Resolved) { if (r.unreadable && !this.warned) [this.warned] = [true, this.log.error({}, '[Shop] Không giải mã được shop.settings (SHOP_SETTINGS_KEY sai/thiếu) -> dùng env cho MỌI trường')]; this.degraded = false; return r; }
  get(): Promise<Resolved> {
    return (this.cache ??= this.read().catch((e) => [(this.degraded = true), this.log.error({ err: e?.message }, '[Shop] Không đọc được shop.settings -> dùng env'), { ...resolveSettings(null, this.env, null), degraded: true }][2] as Resolved));
  }
  reload = (): Promise<Resolved | null> => this.read().then((r) => [(this.cache = Promise.resolve(r)), r][1] as Resolved, () => null);
  /** H-1 (ADR-160): cấu hình ỨNG VIÊN trong bộ nhớ, CHƯA ghi; `commit()` mới ghi DB. Dòng cũ không giải được -> ghi đè cả dòng. DB lỗi -> ném. */
  async prepare(input: Input) {
    const row = await this.store.load();
    const base = row && !resolveSettings(row, this.env, this.key).unreadable ? row : null;
    const enc = (f: string, v: unknown) => (f === 'paymentSourceKeys' ? (v ?? []) : v && SECRET.includes(f as Field) ? aesGcmEncrypt(String(v), this.key!) : v);
    const data = Object.fromEntries([...(base ? [] : ALL.map((f) => [f, null])), ...Object.entries(input)].map(([f, v]) => [f, enc(f as string, v)])) as Partial<SettingsRow>;
    const resolved = resolveSettings({ ...base, ...data, updatedAt: new Date() } as SettingsRow, this.env, this.key);
    return { resolved, commit: async () => [await this.store.save(data), (this.cache = Promise.resolve(resolved))] };
  }
  save = (input: Input) => this.prepare(input).then((p) => p.commit());
}
type Ensure = (client: HubClient, keys: string[]) => Promise<string[]>;
/** Hub client + nguồn tin cậy HIỆN HÀNH — dựng lại khi lưu cài đặt, không redeploy (SPEC §4.3). */
export class HubLink {
  client: HubClient | null = null; sourceKeys: string[] = []; private url = ''; private queue: Promise<unknown> = Promise.resolve();
  readonly registration: HubRegistration;
  constructor(private readonly ensure: Ensure, private readonly log: Log, private readonly allowEnv: NodeJS.ProcessEnv, private readonly make = createHubClient) {
    this.registration = new HubRegistration(() => this.run(this.client!, this.sourceKeys), log);
  }
  private run: Ensure = (client, keys) => (hubHostAllowed(client.baseUrl, this.allowEnv) ? this.ensure(client, keys) : Promise.reject(new Error(hostFix(client.baseUrl))));
  /** L-6: lưu cài đặt + đồng bộ định kỳ chạy TUẦN TỰ. */
  lock = <T>(fn: () => Promise<T>, p = this.queue.then(fn, fn)): Promise<T> => [(this.queue = p.catch(() => undefined)), p][1] as Promise<T>;
  apply(env: NodeJS.ProcessEnv, trusted: string[] = []) {
    [this.url, this.client, this.sourceKeys] = [env.HUB_URL ?? '', env.HUB_URL ? this.make(env.HUB_URL) : null, sourceKeysOf(env)];
    this.registration.reset(trusted);
  }
  /** M-3: cấu hình hub đọc lại từ DB khác link đang chạy (vd boot lúc DB lỗi) -> dựng lại + đăng ký nền. */
  sync(env: NodeJS.ProcessEnv): boolean {
    if ((env.HUB_URL ?? '') === this.url && sourceKeysOf(env).join() === this.sourceKeys.join()) return false;
    [this.apply(env), this.log.info({ project: this.client?.project }, '[Shop] Đồng bộ cấu hình hub từ shop.settings'), this.client && this.registration.start()];
    return true;
  }
  /** M-3/N-5: vòng 60s (main, khi degraded) — lỗi chỉ log, không bao giờ để promise reject không ai bắt (Node ≥ 15 thoát tiến trình). */
  resync = (s: Pick<ShopSettings, 'reload'>) => this.lock(async () => { const r = await s.reload(); if (r) this.sync(r.env); }).then(() => undefined, (e) => this.log.error({ err: e?.message }, '[Shop] Đồng bộ cài đặt định kỳ lỗi'));
  /** H-1 (ADR-160): KIỂM TRƯỚC, LƯU SAU — ensure trên client ỨNG VIÊN; VERIFIED mới `commit()` rồi thay client + nguồn tin cậy một lượt. FAILED: không đổi gì. */
  async reconnect(env: NodeJS.ProcessEnv, commit: () => Promise<unknown> = async () => undefined) {
    let ids: string[] = [];
    try { if (env.HUB_URL) ids = await this.run(this.make(env.HUB_URL), sourceKeysOf(env)); }
    catch (e: any) { const error = String(e?.message ?? e); return { status: 'FAILED', error, verificationFix: /— fix: (.+?)(?: \[requestId|$)/.exec(error)?.[1] ?? null }; }
    try { await commit(); } catch (e: any) { // N-1: hub ĐÃ đổi mà DB không ghi -> ensure lại cấu hình CŨ (exclusive bật lại sub cũ), best effort
      const restored = this.client ? await this.registration.ensureNow() : false;
      return [this.log.error({ err: e?.message, restored }, '[Shop] Hub đã đăng ký cấu hình mới nhưng ghi shop.settings lỗi -> ensure lại cấu hình cũ'), { status: 'COMMIT_FAILED', error: String(e?.message ?? e), restored }][1] as { status: 'COMMIT_FAILED'; error: string; restored: boolean }; }
    this.apply(env, ids);
    return this.client ? { status: 'VERIFIED', project: this.client.project, trustedSourceIds: ids } : { status: 'SKIPPED', error: 'Chưa có HUB_URL — Shop không nối hub' };
  }
}
/** POST /settings/test-hub: `me()` + danh sách source. Lỗi luôn kèm `fix` (khuôn DX1), không bao giờ chứa key. */
export async function testHub(cs: string, make: (cs: string) => HubClient = createHubClient): Promise<Out> {
  const fail = (status: number, error: string, fix: string, extra = {}): Out => ({ status, body: { error, fix, ...extra } });
  try {
    const client = make(cs);
    const me = await client.me();
    if (!me.scopes.includes('manage:endpoints')) return fail(422, 'Key thiếu scope manage:endpoints', 'Console › API key: tạo key mới có tick manage:endpoints (scope của key cũ không sửa được)', me);
    const sources = await client.sources.list().then((l) => l.map(({ sourceKey, provider, name, isActive }) => ({ sourceKey, provider, name, isActive })), (e) => (e?.status === 403 ? null : Promise.reject(e)));
    const sourcesFix = sources ? undefined : 'Key không có manage:sources nên Shop không liệt kê được source: gõ sourceKey (phần cuối Webhook URL ở console › Nguồn) hoặc tạo key có thêm manage:sources';
    return { status: 200, body: { ...me, sources, sourcesFix } };
  } catch (e: any) {
    if (e?.code === 'invalid_connection_string') return fail(400, 'Connection string sai dạng', 'Copy lại từ console › API key (dạng hubs://hk_…@host/project)');
    if (e?.status === 401) return fail(401, 'Hub từ chối key (401)', 'Key sai hoặc đã bị thu hồi — tạo key mới ở console › API key');
    if (e?.status === 404) return fail(404, 'Project trong connection string không khớp key', 'Copy lại nguyên dòng HUB_URL từ console › API key');
    return fail(502, `Không gọi được hub (${e?.code ?? 'lỗi'})`, 'Kiểm host trong connection string; hub free tier có thể đang ngủ — thử lại sau 30–60 giây');
  }
}
/** Mã quản trị (Shop không có đăng nhập, ADR-024): thiếu env hoặc < 24 ký tự (M-2) -> 404 (tắt hẳn); sai -> 401; sai 5 lần/phút/IP -> 429. */
export function adminGate(env: NodeJS.ProcessEnv, log?: Log, now = Date.now) {
  const [fails, token] = [new Map<string, { n: number; until: number }>(), (env.SHOP_ADMIN_TOKEN ?? '').length >= 24 ? env.SHOP_ADMIN_TOKEN! : ''];
  if (env.SHOP_ADMIN_TOKEN && !token) log?.warn({ length: env.SHOP_ADMIN_TOKEN.length }, '[Shop] SHOP_ADMIN_TOKEN ngắn hơn 24 ký tự -> coi như CHƯA đặt (/settings* = 404). Tạo: openssl rand -base64 24');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex'); // so độ dài cố định: không lộ độ dài token
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) return res.status(404).json({ error: 'Không tìm thấy' });
    const [ip, t, given] = [req.ip ?? '?', now(), req.headers['x-shop-admin-token']]; const f = fails.get(ip);
    if (f && f.until > t && f.n >= 5) return res.status(429).json({ error: 'Sai mã quản trị quá nhiều lần — thử lại sau 1 phút' });
    if (typeof given === 'string' && timingSafeCompare(sha(given), sha(token))) return next();
    if (fails.size > 1000) for (const [k, v] of fails) if (v.until <= t) fails.delete(k);
    fails.set(ip, f && f.until > t ? { n: f.n + 1, until: f.until } : { n: 1, until: t + 60_000 });
    return res.status(401).json({ error: 'Sai mã quản trị' });
  };
}
export function settingsRouter(d: { settings: ShopSettings; link: HubLink; env: NodeJS.ProcessEnv; log: Log }) {
  const r = Router().use('/settings', adminGate(d.env, d.log));
  const route = (fn: (req: Request) => Promise<Out>) => (req: Request, res: Response) =>
    fn(req).then((o) => res.status(o.status).json(o.body), (e) => [d.log.error({ err: e?.message }, '[Shop] Lỗi route cài đặt'), res.status(500).json({ error: 'Lỗi cài đặt' })]);
  const [prod, http] = [d.env.NODE_ENV === 'production', (u: unknown) => typeof u === 'string' && /^hub:\/\//.test(u)]; // N-3: hub:// = HTTP thường
  if (prod && http(d.env.HUB_URL)) d.log.warn({}, '[Shop] HUB_URL env là hub:// (HTTP thường) trên production — HUB_SIGNING_SECRET đi không mã hoá; nên dùng hubs://');
  const no = (error: string, fix: string): Out => ({ status: 422, body: { error, field: 'hubConnectionUrl', fix } });
  const badHost = (cs: unknown): Out | null => (prod && http(cs) ? no('hub:// (HTTP thường) bị từ chối trên production', 'dùng hubs:// (HTTPS) — key và HUB_SIGNING_SECRET không đi qua HTTP thường')
    : typeof cs === 'string' && hostOf(cs) && !hubHostAllowed(cs, d.env) ? no('Host hub không được phép', hostFix(cs)) : null);
  r.get('/settings', route(async () => ({ status: 200, body: publicView(await d.settings.get(), !!d.settings.key) })));
  r.post('/settings/test-hub', route(async (req) => badHost(req.body?.hubConnectionUrl) ?? testHub(String(req.body?.hubConnectionUrl ?? ''))));
  r.put('/settings', route((req) => d.link.lock(async () => {
    if (!d.settings.key) return { status: 503, body: { error: 'Shop chưa có SHOP_SETTINGS_KEY (32 byte base64) nên không lưu được bí mật', fix: 'Đặt SHOP_SETTINGS_KEY=$(openssl rand -base64 32) trên Render rồi deploy lại' } };
    const input = parseInput(req.body);
    if ('error' in input) return { status: 400, body: input };
    if (badHost(input.hubConnectionUrl)) return badHost(input.hubConnectionUrl)!;
    const { resolved, commit } = await d.settings.prepare(input);
    const registration = await d.link.reconnect(resolved.env, commit);
    if (registration.status === 'FAILED') {
      d.log.warn({ fields: Object.keys(input), err: registration.error }, '[Shop] Cấu hình mới đăng ký FAILED -> KHÔNG lưu, giữ cấu hình đang chạy');
      return { status: 422, body: { error: 'Chưa lưu: đăng ký với cấu hình mới thất bại — Shop vẫn chạy cấu hình cũ', fix: registration.verificationFix, saved: [], registration, settings: publicView(await d.settings.get(), true) } };
    }
    if (registration.status === 'COMMIT_FAILED') return { status: 500, body: { error: 'Hub đã nhận cấu hình mới nhưng Shop không ghi được DB — có thể đăng ký một phần', fix: 'Bấm Lưu lại (hoặc restart Shop), rồi đối soát log "KHÔNG tin cậy" theo orderCodes', registration } };
    d.log.info({ fields: Object.keys(input), ip: req.ip }, '[Shop] Đã kiểm + lưu cài đặt kết nối (không ghi giá trị)');
    return { status: 200, body: { saved: Object.keys(input), registration, settings: publicView(resolved, true) } };
  })));
  return r;
}
