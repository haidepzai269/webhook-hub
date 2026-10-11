// SK2 (SPEC-shop-ket-noi-project §4, ADR-155): cài đặt kết nối — `shop.settings` thắng env; env cũ là mặc định (cách A).
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
export interface Resolved { env: NodeJS.ProcessEnv; sources: Record<Field, 'db' | 'env' | 'none'>; updatedAt: Date | null }
type Out = { status: number; body: object };
export const sourceKeysOf = (env: NodeJS.ProcessEnv) => (env.SHOP_PAYMENT_SOURCE_KEYS || 'src_payos_main,src_sepay_main').split(',').map((k) => k.trim()).filter(Boolean);
/** `SHOP_SETTINGS_KEY` = 32 byte base64 (`openssl rand -base64 32`); thiếu/ngắn -> null (không lưu được bí mật). */
export const settingsKey = (env: NodeJS.ProcessEnv) => (env.SHOP_SETTINGS_KEY && Buffer.from(env.SHOP_SETTINGS_KEY, 'base64').length >= 32 ? env.SHOP_SETTINGS_KEY : null);
export function resolveSettings(row: SettingsRow | null, env: NodeJS.ProcessEnv, key: string | null, log?: Log): Resolved {
  const [out, sources] = [{ ...env }, {} as Resolved['sources']];
  for (const f of ALL) {
    let v = f === 'paymentSourceKeys' ? row?.paymentSourceKeys?.join(',') || null : (row?.[f] ?? null);
    try { if (v && SECRET.includes(f)) v = aesGcmDecrypt(v, key ?? ''); }
    catch { [v] = [null, log?.error({ field: f }, '[Shop] Không giải mã được cài đặt (SHOP_SETTINGS_KEY sai/thiếu) -> dùng env')]; }
    if (v) out[FIELDS[f]] = v;
    sources[f] = v ? 'db' : env[FIELDS[f]] ? 'env' : 'none';
  }
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
/** Store thật: một dòng `shop.settings` (id = 1), upsert. */
export const prismaStore = (db: PrismaClient) => ({
  load: () => db.shopSetting.findUnique({ where: { id: 1 } }),
  save: (data: Partial<SettingsRow>) => db.shopSetting.upsert({ where: { id: 1 }, create: { ...data, id: 1 }, update: data }),
});
/** Cache trong bộ nhớ, xoá khi lưu. DB lỗi lúc đọc -> dùng env (không cache) để Shop vẫn bán được. */
export class ShopSettings {
  private cache: Promise<Resolved> | null = null;
  constructor(private readonly store: ReturnType<typeof prismaStore> | { load(): Promise<SettingsRow | null>; save(d: Partial<SettingsRow>): Promise<unknown> }, private readonly env: NodeJS.ProcessEnv, private readonly log: Log) {}
  get key() { return settingsKey(this.env); }
  get(): Promise<Resolved> {
    return (this.cache ??= (this.store.load() as Promise<SettingsRow | null>).then((row) => resolveSettings(row, this.env, this.key, this.log), (e) =>
      [(this.cache = null), this.log.error({ err: e?.message }, '[Shop] Không đọc được shop.settings -> dùng env'), resolveSettings(null, this.env, null)][2] as Resolved));
  }
  async save(input: Input): Promise<void> {
    const data = Object.fromEntries(Object.entries(input).map(([f, v]) => [f, f === 'paymentSourceKeys' ? (v ?? []) : v && SECRET.includes(f as Field) ? aesGcmEncrypt(String(v), this.key!) : v]));
    await this.store.save(data as Partial<SettingsRow>);
    this.cache = null;
  }
}
/** Hub client + nguồn tin cậy HIỆN HÀNH — dựng lại khi lưu cài đặt, không redeploy (SPEC §4.3). */
export class HubLink {
  client: HubClient | null = null; sourceKeys: string[] = [];
  readonly registration: HubRegistration;
  constructor(ensure: (client: HubClient, keys: string[]) => Promise<string[]>, log: Log, private readonly make = createHubClient) {
    this.registration = new HubRegistration(() => ensure(this.client!, this.sourceKeys), log);
  }
  apply(env: NodeJS.ProcessEnv) {
    [this.client, this.sourceKeys] = [env.HUB_URL ? this.make(env.HUB_URL) : null, sourceKeysOf(env)];
    this.registration.reset();
  }
  async reconnect(env: NodeJS.ProcessEnv) {
    this.apply(env);
    if (!this.client) return { status: 'SKIPPED', error: 'Chưa có HUB_URL — Shop không nối hub' };
    if (await this.registration.ensureNow()) return { status: 'VERIFIED', project: this.client.project, trustedSourceIds: this.registration.trustedSourceIds };
    const error = this.registration.lastError ?? 'không rõ';
    return { status: 'FAILED', error, verificationFix: /— fix: (.+?)(?: \[requestId|$)/.exec(error)?.[1] ?? null };
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
/** Mã quản trị (Shop không có đăng nhập, ADR-024): thiếu env -> 404 (tắt hẳn); sai -> 401; sai 5 lần/phút/IP -> 429. */
export function adminGate(env: NodeJS.ProcessEnv, now = Date.now) {
  const fails = new Map<string, { n: number; until: number }>();
  const sha = (s: string) => createHash('sha256').update(s).digest('hex'); // so độ dài cố định: không lộ độ dài token
  return (req: Request, res: Response, next: NextFunction) => {
    if (!env.SHOP_ADMIN_TOKEN) return res.status(404).json({ error: 'Không tìm thấy' });
    const [ip, t, given] = [req.ip ?? '?', now(), req.headers['x-shop-admin-token']]; const f = fails.get(ip);
    if (f && f.until > t && f.n >= 5) return res.status(429).json({ error: 'Sai mã quản trị quá nhiều lần — thử lại sau 1 phút' });
    if (typeof given === 'string' && timingSafeCompare(sha(given), sha(env.SHOP_ADMIN_TOKEN))) return next();
    if (fails.size > 1000) for (const [k, v] of fails) if (v.until <= t) fails.delete(k);
    fails.set(ip, f && f.until > t ? { n: f.n + 1, until: f.until } : { n: 1, until: t + 60_000 });
    return res.status(401).json({ error: 'Sai mã quản trị' });
  };
}
export function settingsRouter(d: { settings: ShopSettings; link: HubLink; env: NodeJS.ProcessEnv; log: Log }) {
  const r = Router().use('/settings', adminGate(d.env));
  const route = (fn: (req: Request) => Promise<Out>) => (req: Request, res: Response) =>
    fn(req).then((o) => res.status(o.status).json(o.body), (e) => [d.log.error({ err: e?.message }, '[Shop] Lỗi route cài đặt'), res.status(500).json({ error: 'Lỗi cài đặt' })]);
  r.get('/settings', route(async () => ({ status: 200, body: publicView(await d.settings.get(), !!d.settings.key) })));
  r.post('/settings/test-hub', route((req) => testHub(String(req.body?.hubConnectionUrl ?? ''))));
  r.put('/settings', route(async (req) => {
    if (!d.settings.key) return { status: 503, body: { error: 'Shop chưa có SHOP_SETTINGS_KEY (32 byte base64) nên không lưu được bí mật', fix: 'Đặt SHOP_SETTINGS_KEY=$(openssl rand -base64 32) trên Render rồi deploy lại' } };
    const input = parseInput(req.body);
    if ('error' in input) return { status: 400, body: input };
    await d.settings.save(input);
    d.log.info({ fields: Object.keys(input), ip: req.ip }, '[Shop] Đã lưu cài đặt kết nối (không ghi giá trị)');
    const resolved = await d.settings.get(); // cache vừa bị xoá -> đọc lại từ DB
    return { status: 200, body: { saved: Object.keys(input), registration: await d.link.reconnect(resolved.env), settings: publicView(resolved, true) } };
  }));
  return r;
}
