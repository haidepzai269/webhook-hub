import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { SourceConnectionService } from '../src/modules/console/source-connection.service';
import { publicIngestBase, sourceIngestUrl } from '../src/modules/console/public-ingest-base';
import { hubPublicUrl } from '../src/modules/console/projects.controller';
import { publicHooksUrl } from '../src/modules/ingest/ingest.service';

/**
 * §9 (SPEC-hub-sap, ĐÍNH CHÍNH H4, ADR-211): `HUB_INGEST_PUBLIC_URL` = URL provider gọi vào (`/hooks/*`), tách khỏi
 * `HUB_PUBLIC_URL` (API, console, connection string). Thiếu/rỗng -> rơi về `HUB_PUBLIC_URL` y như cũ.
 * Prisma giả: chỉ đủ hàm `retry`/`status` chạm tới — ghi lại URL đăng ký tại provider và trạng thái DRIFTED.
 */
const RENDER = 'https://hub-api-xxxx.onrender.com';
const WORKERS = 'https://hub-hooks.webhookhub.workers.dev';
const SRC = randomUUID();

function fakePrisma(conn: Record<string, unknown>) {
  const claims: any[] = [];
  const updates: any[] = [];
  const source = { id: SRC, provider: 'stripe', sourceKey: 'src_stripe_main', isActive: true, archivedAt: null, secrets: [] };
  const repo = {
    findSourceById: async () => source,
    findSourceConnection: async () => conn,
    lockFlowConfig: async () => undefined,
    // Lượt khác "đang PENDING" -> retry trả 409 ngay sau khi ghi URL — đủ để đọc URL sẽ đăng ký, không gọi provider.
    claimSourceConnection: async (_id: string, _stale: Date, data: any) => (claims.push(data), null),
    updateSourceConnectionIf: async (_id: string, _guard: unknown, patch: any) => (updates.push(patch), { ...conn, ...patch }),
    findRecentRawEventsForSource: async () => [],
  };
  const prisma: any = { forTenant: () => repo, tenantTx: (_t: string, fn: any) => fn(undefined) };
  return { prisma, claims, updates };
}

const connected = (ingestUrl: string) => ({
  sourceId: SRC,
  provider: 'stripe',
  status: 'CONNECTED',
  ingestUrl,
  remoteRef: null, // không hỏi provider: chỉ phần so URL mong đợi
  credentialsEncrypted: null,
  lastCheckedAt: null,
  lastError: null,
  lastFix: null,
  updatedAt: new Date(),
});

async function registeredUrl(env: Record<string, string | undefined>): Promise<string> {
  const f = fakePrisma(connected('x'));
  const svc = new SourceConnectionService(f.prisma, env);
  const e = await svc.retry('t', 'user:u', SRC, { credentials: { secretKey: 'rk_test_x' } }).then(() => null, (x) => x);
  expect(e).toBeInstanceOf(HttpException);
  expect((e as HttpException).getStatus()).toBe(409);
  expect(f.claims).toHaveLength(1);
  return f.claims[0].ingestUrl;
}

async function statusOf(env: Record<string, string | undefined>, storedIngestUrl: string) {
  const f = fakePrisma(connected(storedIngestUrl));
  return new SourceConnectionService(f.prisma, env).status('t', SRC);
}

describe('[LH-URL] HUB_INGEST_PUBLIC_URL tách khỏi HUB_PUBLIC_URL (§9, ADR-211)', () => {
  const prevKey = process.env.MASTER_KEY;
  beforeAll(() => {
    process.env.MASTER_KEY = prevKey || 'lh-t17-master-key-at-least-32-chars!!';
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = prevKey;
  });

  it('[LH:T17] (phần a) chỉ có HUB_PUBLIC_URL (hoặc HUB_INGEST_PUBLIC_URL rỗng) -> mọi URL ingest như cũ', async () => {
    for (const env of [{ HUB_PUBLIC_URL: RENDER }, { HUB_PUBLIC_URL: RENDER, HUB_INGEST_PUBLIC_URL: '' }, { HUB_PUBLIC_URL: RENDER, HUB_INGEST_PUBLIC_URL: '   ' }]) {
      expect(publicIngestBase(env)).toBe(RENDER);
      expect(publicHooksUrl({ provider: 'generic', sourceKey: 'k', query: 'a=1' }, env)).toBe(`${RENDER}/hooks/generic/k?a=1`);
      expect(await registeredUrl(env)).toBe(`${RENDER}/hooks/stripe/src_stripe_main`);
      expect(hubPublicUrl(env as unknown as NodeJS.ProcessEnv)).toBe(RENDER);
      expect(sourceIngestUrl('github', 'k', env)).toBe(`${RENDER}/hooks/github/k`);
      // URL đã đăng ký = URL mong đợi -> không DRIFTED.
      const v = await statusOf(env, `${RENDER}/hooks/stripe/src_stripe_main`);
      expect([v.status, v.lastError]).toEqual(['CONNECTED', null]);
    }
    // Chỉ HUB_PUBLIC_URL mà là localhost -> 422 như cũ, lời nhắc gọi đúng tên biến đang có hiệu lực.
    const svc = new SourceConnectionService(fakePrisma(connected('x')).prisma, { HUB_PUBLIC_URL: 'http://localhost:4000' });
    const e = await svc.retry('t', 'user:u', SRC, { credentials: { secretKey: 'rk_test_x' } }).then(() => null, (x) => x);
    expect((e as HttpException).getStatus()).toBe(422);
    expect(JSON.stringify((e as HttpException).getResponse())).toMatch(/public_url_required[\s\S]*HUB_PUBLIC_URL/);
  });

  it('[LH:T17] (phần b) có cả hai -> URL ingest / đăng ký / DRIFTED / publicHooksUrl dùng HUB_INGEST_PUBLIC_URL; connection string giữ HUB_PUBLIC_URL', async () => {
    const env = { HUB_PUBLIC_URL: RENDER, HUB_INGEST_PUBLIC_URL: `${WORKERS}/` };
    expect(publicIngestBase(env)).toBe(WORKERS);
    expect(publicHooksUrl({ provider: 'generic', sourceKey: 'k', query: '' }, env)).toBe(`${WORKERS}/hooks/generic/k`);
    expect(await registeredUrl(env)).toBe(`${WORKERS}/hooks/stripe/src_stripe_main`);
    expect(hubPublicUrl(env as unknown as NodeJS.ProcessEnv)).toBe(RENDER);
    // URL console cho dev copy; stack kiểm chứng (CONNECTOR_INGEST_BASE_URL = tên trong mạng docker) không lọt ra màn hình.
    expect(sourceIngestUrl('github', 'k', env)).toBe(`${WORKERS}/hooks/github/k`);
    expect(sourceIngestUrl('github', 'k', { ...env, CONNECTOR_INGEST_BASE_URL: 'http://hub-api:4000' })).toBe(`${WORKERS}/hooks/github/k`);
    expect(sourceIngestUrl('github', 'k', { HUB_PUBLIC_URL: 'http://localhost:4000' })).toBeNull();
    // Đã đăng ký đúng URL lưới -> CONNECTED.
    const v = await statusOf(env, `${WORKERS}/hooks/stripe/src_stripe_main`);
    expect([v.status, v.lastError]).toEqual(['CONNECTED', null]);
    // HUB_INGEST_PUBLIC_URL không công khai -> 422 dù HUB_PUBLIC_URL công khai (không rơi về), lời nhắc gọi đúng biến mới.
    const bad = new SourceConnectionService(fakePrisma(connected('x')).prisma, { HUB_PUBLIC_URL: RENDER, HUB_INGEST_PUBLIC_URL: 'http://localhost:8787' });
    const e = await bad.retry('t', 'user:u', SRC, { credentials: { secretKey: 'rk_test_x' } }).then(() => null, (x) => x);
    expect((e as HttpException).getStatus()).toBe(422);
    expect(JSON.stringify((e as HttpException).getResponse())).toContain('HUB_INGEST_PUBLIC_URL');
    expect(publicIngestBase({ HUB_PUBLIC_URL: RENDER, HUB_INGEST_PUBLIC_URL: 'http://localhost:8787' })).toBeNull();
  });

  it('[LH:T17] (phần c) đổi HUB_INGEST_PUBLIC_URL (source cũ đăng ký URL Render) -> DRIFTED public_url_changed, lời nhắc nói biến mới', async () => {
    const v = await statusOf({ HUB_PUBLIC_URL: RENDER, HUB_INGEST_PUBLIC_URL: WORKERS }, `${RENDER}/hooks/stripe/src_stripe_main`);
    expect([v.status, v.lastError]).toEqual(['DRIFTED', 'public_url_changed']);
    expect(v.fix).toContain('HUB_INGEST_PUBLIC_URL');
    // Ngược lại: bỏ biến mới (rơi về Render) trong khi đã đăng ký URL lưới -> cũng DRIFTED.
    const back = await statusOf({ HUB_PUBLIC_URL: RENDER }, `${WORKERS}/hooks/stripe/src_stripe_main`);
    expect([back.status, back.lastError]).toEqual(['DRIFTED', 'public_url_changed']);
  });
});
