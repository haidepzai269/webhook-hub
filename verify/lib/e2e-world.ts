/**
 * VF4: "thế giới" dùng chung cho kịch bản L2 — đi ĐÚNG đường của một dev bên ngoài (SPEC-verification §5.5):
 * đăng ký → bấm link trong mail (MAIL_DRIVER=capture) → project của mình → tạo key → tạo source → gửi webhook.
 * Chỉ HTTP + hub-sim (ký độc lập) + psql/Redis của hubv cho các assert nhìn xuyên (không bao giờ cho deployed).
 * KHÔNG import code hub.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import { composeOutput, hostUrls, loadVerifyEnv, ROOT } from './compose';
import { expect, HttpSession } from './http-session';
import { waitFor } from './scenario';
import { Fixture, loadFixture, prepare, Prepared } from '../../tools/hub-sim/src/fixture';
import { SECRET_ENV } from '../../tools/hub-sim/cli';

export const API = process.env.VERIFY_API_URL || hostUrls().HUB_API_URL;
export const SINK = process.env.VERIFY_SINK_URL || 'http://localhost:14100';
/** Sink nhìn từ TRONG mạng compose (hub-api gọi ra). */
export const SINK_INTERNAL = process.env.VERIFY_SINK_INTERNAL_URL || 'http://sink:4100';
export const RUN = randomUUID().slice(0, 8);
export const PASSWORD = 'ca-phe-sua-da-2026';
const MAIL_DIR = path.join(ROOT, 'verify', '.mail');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let redis: Redis | null = null;
export async function flushRateLimits(): Promise<void> {
  if (!redis) {
    redis = new Redis(process.env.VERIFY_REDIS_URL || hostUrls().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on('error', () => undefined); // chaos tắt Redis hubv: lỗi kết nối nền không phải lỗi kịch bản
  }
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);
}
export async function closeWorld(): Promise<void> {
  await redis?.quit().catch(() => undefined);
  redis = null;
}

export function psql(sql: string): string {
  const r = composeOutput(['exec', '-T', 'postgres', 'psql', '-U', 'hub_user', '-d', 'webhook_hub', '-tA', '-F', '|', '-c', sql]);
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout.trim();
}

export async function mailLink(to: string, re: RegExp): Promise<string> {
  return waitFor(`thư tới ${to} khớp ${re}`, async () => {
    const files = fs.existsSync(MAIL_DIR) ? fs.readdirSync(MAIL_DIR).filter((f) => f.endsWith('.json')).sort().reverse() : [];
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(MAIL_DIR, f), 'utf8')) as { to?: string; text?: string };
        const hit = m.to === to ? re.exec(m.text ?? '') : null;
        if (hit) return hit[0];
      } catch {
        /* file đang ghi dở */
      }
    }
    return null;
  }, 10_000, 250);
}

export interface Dev {
  s: HttpSession;
  email: string;
  projectId: string;
  slug: string;
}

/** Đăng ký + xác minh qua link trong mail capture (AU1/AU2) -> phiên đăng nhập + project owner. */
export async function registerDev(tag: string): Promise<Dev> {
  await flushRateLimits();
  const s = new HttpSession(API);
  const email = `${tag}-${RUN}@e2e.test`;
  const r = await s.post('/auth/register', { email, name: `E2E ${tag}`, password: PASSWORD });
  expect(r.status === 201, `register → ${r.status} ${r.text}`);
  const link = await mailLink(email, /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9_-]+/);
  const v = await s.post('/auth/verify-email', { token: new URL(link).searchParams.get('token'), password: PASSWORD, name: `E2E ${tag}` });
  expect(v.status === 200, `verify-email → ${v.status} ${v.text}`);
  const m = v.body?.memberships?.[0];
  expect(m?.role === 'owner' && m.projectId && m.slug, `membership owner: ${JSON.stringify(v.body?.memberships)}`);
  return { s, email, projectId: m.projectId, slug: m.slug };
}

export async function createKey(dev: Dev, serviceName: string, scopes: string[]): Promise<string> {
  const k = await dev.s.post(`/api/v1/projects/${dev.projectId}/keys`, { serviceName, scopes });
  expect(k.status === 201 && typeof k.body?.key === 'string', `tạo key → ${k.status} ${k.text}`);
  return k.body.key;
}

/** Gọi `/v1/p/:slug/*` bằng API key (Bearer). */
export async function svc(key: string, slug: string, method: string, p: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(`${API}/v1/p/${slug}${p}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed, text };
}

/** Secret PHÍA PROVIDER (giả) cho provider, từ .env.verify — hub-sim ký bằng nó, source của hub lưu cùng giá trị. */
export function simSecret(provider: Fixture['provider']): string {
  const v = loadVerifyEnv()[SECRET_ENV[provider]];
  if (!v) throw new Error(`.env.verify thiếu ${SECRET_ENV[provider]}`);
  return v;
}

export interface Source {
  id: string;
  sourceKey: string;
  webhookUrl: string;
}

export async function createSource(key: string, slug: string, provider: Fixture['provider'], verificationConfig?: Record<string, unknown>): Promise<Source> {
  const r = await svc(key, slug, 'POST', '/sources', {
    provider,
    name: `${provider} e2e ${RUN}`,
    secret: simSecret(provider),
    ...(verificationConfig ? { verificationConfig } : {}),
  });
  expect(r.status === 201 || r.status === 200, `tạo source ${provider} → ${r.status} ${r.text}`);
  return r.body;
}

/** Ký lại fixture bằng secret giả rồi POST vào `webhookUrl` (đường dẫn tương đối của hub). */
export async function sendFixture(id: string, webhookUrl: string, unique: string, mutate?: (p: Prepared) => Prepared): Promise<{ status: number; text: string; f: Fixture }> {
  const f = loadFixture(id);
  let p = prepare(f, simSecret(f.provider), { unique });
  if (mutate) p = mutate(p);
  const r = await fetch(`${API}${webhookUrl}`, { method: 'POST', headers: p.headers, body: new Uint8Array(p.body) });
  return { status: r.status, text: await r.text(), f };
}

/** Số duy nhất cho `--unique` của hub-sim (chỉ chữ số, ≤ 9). */
let seq = 0;
export function uniq(): string {
  seq += 1;
  return `${Date.now() % 1_000_000}${seq}`.slice(-9);
}
