import express, { Request, Response } from 'express';
import cors from 'cors';
import { Prisma, PrismaClient } from '@prisma/client';
import { timingSafeCompare } from '@hub/crypto';
import { challengeResponse, verifyWebhook } from '@hub/sdk';
import { logger } from '@hub/common';
import { MENU, priceOrder, maskCustomer, type Customer } from './menu';
import { applyPayment, bankQrUrl, creditsOrder, EXPIRE_AFTER_MS, isExpired, newOrderCode, orderCodesIn, pickOrderCode, readPayment } from './payment';
import { createPaymentLink, PAYOS_DUPLICATE_ORDER, payosConfig, payosLinkInput } from './payos';
import { HubLink, prismaStore, settingsRouter, ShopSettings } from './settings';

const expressFactory = typeof express === 'function' ? express : (express as any).default || require('express');
const app = expressFactory();
const prisma = new PrismaClient();
const PORT = process.env.SHOP_PORT || 4001;
// S11 (§4.12): KHÔNG còn secret gắn cứng — thiếu thì Shop không khởi động (lỗi rõ ràng).
const SIGNING_SECRET = process.env.HUB_SIGNING_SECRET || '';
if (!SIGNING_SECRET) [logger.error('[Shop] Thiếu HUB_SIGNING_SECRET (secret ký Standard Webhooks của endpoint Shop) -> dừng'), process.exit(1)];
// SK2 (ADR-155): HUB_URL / nguồn tin cậy / PayOS / VietQR đọc qua `settings` — `shop.settings` thắng env, env là mặc định.
const settings = new ShopSettings(prismaStore(prisma), process.env, logger);
const SHOP_PUBLIC_URL = (process.env.SHOP_PUBLIC_URL || `http://localhost:${process.env.SHOP_PORT || 4001}`).replace(/\/$/, '');
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';
const SHOP_WEB_URL = (process.env.SHOP_WEB_URL || 'http://localhost:3000/shop').replace(/\/$/, ''); // P1 (ADR-141): PayOS đưa khách quay lại

app.set('trust proxy', 1); // Render: IP thật của khách cho giới hạn sai mã quản trị (SK2)
app.use(cors());
app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) })); // giữ rawBody để kiểm chữ ký HMAC
app.use((err: any, _req: Request, res: Response, next: any) => (err?.type === 'entity.parse.failed' ? res.status(400).json({ error: 'JSON không hợp lệ' }) : next(err)));

// 1. GET /products — Menu đồ ăn, giá thật VND (ADR-027)
app.get('/products', (_req: Request, res: Response) => res.json(MENU));
app.get('/payment-options', async (_req: Request, res: Response) => {
  const { env } = await settings.get();
  res.json({ payos: !!payosConfig(env), bankQr: !!bankQrUrl(env, 1, 'DH') });
});

// 2. POST /orders — Tạo đơn từ giỏ hàng. Server tự tính tổng, KHÔNG đọc `amount` từ body (ADR-024)
app.post('/orders', async (req: Request, res: Response) => {
  try {
    const priced = priceOrder(req.body);
    if ('error' in priced) return res.status(400).json({ error: priced.error });
    const paymentProvider = req.body.paymentProvider === 'payos' ? 'payos' : 'sepay';
    const { env } = await settings.get();
    const payos = payosConfig(env);
    if (paymentProvider === 'payos' && !payos) return res.status(400).json({ error: 'Shop chưa cấu hình PayOS — chọn chuyển khoản ngân hàng' });
    // Mã đơn DH + 7 chữ số (ADR-141); trùng @unique (P2002) thì sinh lại, tối đa 3 lần
    let order;
    for (let attempt = 0; !order; attempt++) {
      try {
        const json = (v: unknown) => v as Prisma.InputJsonValue;
        order = await prisma.order.create({ data: { orderCode: newOrderCode(), amount: BigInt(priced.amount), status: 'PENDING', paymentProvider, items: json(priced.items), customer: json(priced.customer) } });
      } catch (e: any) {
        if (e?.code !== 'P2002' || attempt >= 2) throw e;
      }
    }
    const expiresAt = new Date(order.createdAt.getTime() + EXPIRE_AFTER_MS);
    // PayOS: link thật, hết hạn SỚM hơn đơn (ADR-144). SePay: VietQR của tài khoản nhận (hoặc null).
    let payment: { qrImageUrl: string | null; qrCode?: string; checkoutUrl?: string } = { qrImageUrl: bankQrUrl(env, priced.amount, order.orderCode) };
    if (paymentProvider === 'payos' && payos) {
      try {
        let link;
        for (let attempt = 0; !link; attempt++) {
          try {
            link = await createPaymentLink(payos, payosLinkInput({ orderCode: order.orderCode, amount: priced.amount, createdAt: order.createdAt, expiresAt }, SHOP_WEB_URL));
          } catch (e: any) {
            // L-3: PayOS đã có orderCode này (vd DB Shop dựng lại) -> đổi mã đơn, thử lại MỘT lần
            if (e?.code !== PAYOS_DUPLICATE_ORDER || attempt >= 1) throw e;
            order = await prisma.order.update({ where: { id: order.id }, data: { orderCode: newOrderCode() } });
          }
        }
        await prisma.order.update({ where: { id: order.id }, data: { payosPaymentLinkId: link.paymentLinkId } });
        payment = { qrImageUrl: null, qrCode: link.qrCode, checkoutUrl: link.checkoutUrl }; // ADR-154: web tự vẽ QR
      } catch (e: any) {
        logger.error({ err: e?.message, orderCode: order.orderCode }, '[Shop] Không tạo được link PayOS (đơn để PENDING, tự hết hạn)');
        return res.status(502).json({ error: 'Không tạo được link thanh toán PayOS — thử lại hoặc chọn chuyển khoản ngân hàng' });
      }
    }
    const { id, orderCode, status } = order;
    res.json({ success: true, order: { id, orderCode, amount: priced.amount, status, items: priced.items, paymentProvider, expiresAt, payment } });
  } catch (err: any) {
    logger.error({ err: err.message }, '[Shop] Lỗi tạo đơn');
    res.status(500).json({ error: 'Không tạo được đơn hàng' });
  }
});

// 3. GET /orders/:code — Lấy thông tin & trạng thái đơn hàng
app.get('/orders/:code', async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { orderCode: String(req.params.code) } });
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    const { orderCode, items, createdAt } = order;
    const status = isExpired(order) ? 'EXPIRED' : order.status; // L-2: hết hạn lười, chỉ hiển thị (cron ghi sau)
    const customer = maskCustomer(order.customer as unknown as Customer | null);
    res.json({ orderCode, status, amount: Number(order.amount), paidAmount: Number(order.paidAmount), expiresAt: new Date(createdAt.getTime() + EXPIRE_AFTER_MS), items, customer, createdAt });
  } catch (err: any) {
    logger.error({ err: err.message }, '[Shop] Lỗi đọc đơn');
    res.status(500).json({ error: 'Không đọc được đơn hàng' });
  }
});

// 4. POST /hub-webhook — Nhận outbound webhook từ Webhook Hub
app.post('/hub-webhook', async (req: any, res: Response) => {
  // 4.1. Standard Webhooks (ADR-040): chữ ký trên bytes gốc + timestamp ≤ 300s, kể cả challenge. `webhook-id` = khoá chống trùng.
  const eventId = req.headers['webhook-id'] as string;
  if (!verifyWebhook(req.rawBody ?? Buffer.alloc(0), req.headers, SIGNING_SECRET)) return res.status(401).json({ error: 'Chữ ký Standard Webhooks không hợp lệ hoặc quá hạn' });
  const challenge = challengeResponse(req.body);
  if (challenge) return res.status(200).json(challenge);
  // 4.3. Chỉ `payment.received` (VND) từ sourceId đã ghim (R-1, ADR-094). Chưa ghim -> thử đăng ký NGAY (R2-1), vẫn
  // chưa được thì 503 để hub retry — không xử lý tiền khi chưa biết nguồn nào tin được (R-8).
  const { client: hub, registration } = hubLink;
  if (hub && registration.trustedSourceIds.length === 0 && !(await registration.ensureNow())) return res.status(503).json({ error: 'Shop chưa đăng ký xong với hub' });
  const p = readPayment(req.body, undefined, hub ? registration.trustedSourceIds : undefined);
  if ('skip' in p || !eventId) {
    // M-1: source không tin cậy (vd project cũ sau khi chuyển) — 200 nhưng để lại dấu vết đối soát (không có bí mật).
    if ('skip' in p && p.skip !== 'IGNORED') logger.warn({ eventId, sourceId: req.body?.sourceId, orderCodes: orderCodesIn(req.body?.data) }, p.skip === 'UNMATCHED' ? '[Shop] Không tìm thấy mã đơn DH trong memo/reference' : '[Shop] payment.received từ source KHÔNG tin cậy -> bỏ qua; có mã đơn thì cần đối soát');
    return res.status(200).json({ success: true, status: 'skip' in p ? p.skip : 'IGNORED' });
  }
  const { orderCodes, amount, source, paidAt } = p;
  let orderCode = orderCodes[0];
  // 4.4. Chống trùng BỀN VỮNG + cộng dồn trong CÙNG transaction (ADR-034): event-id và paidAmount cùng commit/rollback.
  // Khoá hàng đơn (FOR UPDATE) trước: webhook/reconcile trên CÙNG đơn chạy tuần tự -> không 4xx (hub coi là DEAD).
  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ order_code: string }[]>`SELECT order_code FROM shop.orders WHERE order_code = ANY(${orderCodes}) ORDER BY order_code FOR UPDATE`;
      const code = pickOrderCode(orderCodes, locked.map((r) => r.order_code)); // M-3: mã có thật, không phải tiền tố lạ
      if (!code) return { status: 'ORDER_NOT_FOUND' };
      orderCode = code;
      if (await tx.processedHubEvent.findUnique({ where: { eventId } })) return { status: 'DUPLICATE' };
      const order = await tx.order.findUniqueOrThrow({ where: { orderCode } });
      if (!creditsOrder(order.paymentProvider, source)) return { status: 'OTHER_CHANNEL' }; // M-2: không cộng đôi
      await tx.processedHubEvent.create({ data: { eventId, orderId: order.id, amount: BigInt(amount) } });
      const next = applyPayment(order, BigInt(amount), paidAt);
      // Phòng thủ (đã khoá hàng nên lẽ ra không xảy ra): lệch version -> rollback cả event-id
      const updated = await tx.order.updateMany({ where: { id: order.id, version: order.version }, data: { status: next.status, paidAmount: next.paidAmount, version: { increment: 1 } } });
      if (updated.count === 0) throw new Error('VERSION_CONFLICT');
      return { status: next.outcome, paidAmount: Number(next.paidAmount) };
    });
    if (['LATE_PAYMENT', 'EXTRA_PAYMENT', 'OTHER_CHANNEL'].includes(result.status)) {
      logger.warn({ orderCode, amount, source, eventId }, `[Shop] ${result.status}: ${({ LATE_PAYMENT: 'trả sau hạn, ĐÃ cộng dồn vào đơn nhưng chưa đủ (hoặc đơn đã huỷ) — chờ khoản sau hoặc đối soát/hoàn tiền', EXTRA_PAYMENT: 'đơn đã PAID, khoản này được ghi thêm — cần hoàn phần dư', OTHER_CHANNEL: 'tiền về kênh khác kênh của đơn, KHÔNG cộng — cần đối soát' } as Record<string, string>)[result.status]}`); // L-2
    } else {
      logger.info({ orderCode, amount, ...result }, `[Shop] Webhook đơn ${orderCode}: ${result.status}`);
    }
    res.status(200).json({ success: true, orderCode, ...result });
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(200).json({ success: true, status: 'DUPLICATE', orderCode });
    if (err?.message === 'VERSION_CONFLICT') {
      // 503 (không phải 409): hub coi 4xx là non-retryable -> DEAD, mất khoản tiền. 5xx thì hub retry.
      return res.status(503).json({ error: 'Đơn đang được cập nhật, thử lại sau' });
    }
    logger.error({ err: err?.message, orderCode }, '[Shop] Lỗi xử lý webhook');
    res.status(500).json({ error: 'Lỗi xử lý webhook' });
  }
});

// 5. Đối soát: đơn PENDING quá hạn -> EXPIRED. UNDERPAID giữ nguyên (đã có tiền vào).
async function expireStaleOrders() {
  const { count } = await prisma.order.updateMany({ where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - EXPIRE_AFTER_MS) } }, data: { status: 'EXPIRED', version: { increment: 1 } } });
  if (count > 0) logger.info({ count }, '[Shop] Reconcile: chuyển đơn quá hạn sang EXPIRED');
  return count;
}

// POST /api/internal/reconcile — gọi bởi GitHub Actions (deployed, ADR-022), bắt buộc X-Internal-Token
app.post('/api/internal/reconcile', async (req: Request, res: Response) => {
  if (!INTERNAL_TOKEN) return res.status(503).json({ error: 'INTERNAL_TOKEN chưa được cấu hình' });
  const token = req.headers['x-internal-token'];
  if (typeof token !== 'string' || !timingSafeCompare(token, INTERNAL_TOKEN)) return res.status(401).json({ error: 'Sai X-Internal-Token' });
  try {
    // ADR-141: tiền về đơn đã hết hạn KHÔNG mất âm thầm — đối soát báo số đơn EXPIRED có tiền (cần giao/hoàn tiền).
    const expiredCount = await expireStaleOrders();
    res.json({ expiredCount, lateMoneyOrders: await prisma.order.count({ where: { status: 'EXPIRED', paidAmount: { gt: 0 } } }) });
  } catch (err: any) {
    logger.error({ err: err?.message }, '[Shop] Lỗi reconcile');
    res.status(500).json({ error: 'Reconcile thất bại' });
  }
});

// Local: tự reconcile định kỳ (docker-compose đặt RECONCILE_INTERVAL_MS)
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 0);
if (RECONCILE_INTERVAL_MS > 0) setInterval(() => expireStaleOrders().catch((e) => logger.error({ err: e?.message }, '[Shop] Reconcile lỗi')), RECONCILE_INTERVAL_MS);

// S11: Shop TỰ đăng ký endpoint + subscription `payment.received` (idempotent), ghim ĐÚNG source tin cậy, tắt sub cũ (MS-P2-1);
// thử lại vô hạn (R2-1). SK2: lưu cài đặt -> `hubLink.reconnect()` dựng lại client + ensure NGAY (không redeploy).
const hubLink = new HubLink(async (hub, sourceKeys) => {
  const r = await hub.endpoints.ensure({ name: 'shop', url: `${SHOP_PUBLIC_URL}/hub-webhook`, eventTypes: ['payment.received'], signingSecret: SIGNING_SECRET, sourceKeys, exclusive: true });
  logger.info({ endpointId: r.endpoint.id, created: r.created, hub, trustedSourceIds: r.subscription.sourceIds }, `[Shop] endpoint VERIFIED (${r.endpoint.url}), subscription payment.received`);
  return r.subscription.sourceIds ?? [];
}, logger, process.env);
app.use(settingsRouter({ settings, link: hubLink, env: process.env, log: logger }));

// Nạp cài đặt TRƯỚC khi nhận request: webhook không bao giờ tới lúc chưa biết hub/nguồn tin cậy. M-3: boot lúc DB lỗi -> env, 60s thử lại tới khi đọc được.
setInterval(() => settings.degraded && void hubLink.lock(async () => { const r = await settings.reload(); if (r) hubLink.sync(r.env); }), 60_000).unref();
void settings.get().then(({ env }) => {
  hubLink.apply(env);
  app.listen(PORT, () => {
    logger.info(`🛒 Demo Shop API đang chạy trên cổng ${PORT} (trần ~600 dòng, ADR-156)`);
    if (hubLink.client) hubLink.registration.start();
    else logger.warn('[Shop] Không có HUB_URL -> không tự đăng ký endpoint với hub');
  });
});
