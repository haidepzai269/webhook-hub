import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomInt } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { swVerify, timingSafeCompare } from '@hub/crypto';
import { logger } from '@hub/common';
import { MENU, priceOrder, maskCustomer, type Customer } from './menu';
import { applyPayment, EXPIRE_AFTER_MS, readPayment } from './payment';

const expressFactory = typeof express === 'function' ? express : (express as any).default || require('express');
const app = expressFactory();
const prisma = new PrismaClient();
const PORT = process.env.SHOP_PORT || 4001;
const SIGNING_SECRET = process.env.HUB_SIGNING_SECRET || 'hub_outbound_signing_secret_999';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

app.use(cors());
// Giữ rawBody để kiểm tra chữ ký HMAC
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use((err: any, _req: Request, res: Response, next: any) =>
  err?.type === 'entity.parse.failed' ? res.status(400).json({ error: 'JSON không hợp lệ' }) : next(err),
);

// 1. GET /products — Menu đồ ăn, giá thật VND (ADR-027)
app.get('/products', (_req: Request, res: Response) => {
  res.json(MENU);
});

// 2. POST /orders — Tạo đơn từ giỏ hàng. Server tự tính tổng, KHÔNG đọc `amount` từ body (ADR-024)
app.post('/orders', async (req: Request, res: Response) => {
  try {
    const priced = priceOrder(req.body);
    if ('error' in priced) return res.status(400).json({ error: priced.error });
    const paymentProvider = req.body.paymentProvider === 'payos' ? 'payos' : 'sepay';

    // Mã đơn DH + 10 chữ số; trùng @unique (P2002) thì sinh lại, tối đa 3 lần
    let order;
    for (let attempt = 0; !order; attempt++) {
      const orderCode = `DH${Date.now().toString().slice(-6)}${randomInt(10000).toString().padStart(4, '0')}`;
      try {
        order = await prisma.order.create({
          data: {
            orderCode,
            amount: BigInt(priced.amount),
            status: 'PENDING',
            paymentProvider,
            payosPaymentLinkId: `link_${orderCode}`,
            items: priced.items as unknown as Prisma.InputJsonValue,
            customer: priced.customer as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (e: any) {
        if (e?.code !== 'P2002' || attempt >= 2) throw e;
      }
    }

    res.json({
      success: true,
      order: {
        id: order.id,
        orderCode: order.orderCode,
        amount: Number(order.amount),
        status: order.status,
        items: priced.items,
        qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${order.orderCode}%20${order.amount}`,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, '[Shop] Lỗi tạo đơn');
    res.status(500).json({ error: 'Không tạo được đơn hàng' });
  }
});

// 3. GET /orders/:code — Lấy thông tin & trạng thái đơn hàng
app.get('/orders/:code', async (req: Request, res: Response) => {
  try {
    const codeParam = String(req.params.code);
    // Cột id là @db.Uuid: so chuỗi không phải UUID sẽ làm Prisma ném P2023
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codeParam);
    const order = await prisma.order.findFirst({
      where: isUuid ? { OR: [{ id: codeParam }, { orderCode: codeParam }] } : { orderCode: codeParam },
    });
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    res.json({
      orderCode: order.orderCode,
      status: order.status,
      amount: Number(order.amount),
      paidAmount: Number(order.paidAmount),
      items: order.items,
      customer: maskCustomer(order.customer as unknown as Customer | null),
      createdAt: order.createdAt,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, '[Shop] Lỗi đọc đơn');
    res.status(500).json({ error: 'Không đọc được đơn hàng' });
  }
});

// 4. POST /hub-webhook — Nhận outbound webhook từ Webhook Hub
app.post('/hub-webhook', async (req: any, res: Response) => {
  // 4.1. Standard Webhooks (ADR-040): chữ ký trên bytes gốc + timestamp lệch ≤ 300s (chống replay) — hub ký,
  // shop chỉ verify bằng lib dùng chung. `webhook-id` = event id, giữ nguyên qua retry -> khoá chống trùng.
  const eventId = req.headers['webhook-id'] as string;
  if (!swVerify(SIGNING_SECRET, req.headers, req.rawBody ?? Buffer.alloc(0))) {
    return res.status(401).json({ error: 'Chữ ký Standard Webhooks không hợp lệ hoặc quá hạn' });
  }

  // 4.3. Chỉ nhận kiểu chuẩn `payment.received` (VND); mã đơn DH\d+ trong data.memo rồi data.reference
  const p = readPayment(req.body);
  if ('skip' in p || !eventId) {
    if ('skip' in p && p.skip === 'UNMATCHED') logger.warn({ eventId }, '[Shop] Không tìm thấy mã đơn DHxxx trong memo/reference');
    return res.status(200).json({ success: true, status: 'skip' in p ? p.skip : 'IGNORED' });
  }
  const { orderCode, amount } = p;

  // 4.4. Chống trùng BỀN VỮNG + cộng dồn trong CÙNG transaction (ADR-034): ghi event-id và
  // paidAmount cùng commit hoặc cùng rollback -> mỗi khoản chỉ cộng một lần, thứ tự đến không quan trọng.
  // Khoá hàng đơn (FOR UPDATE) trước tiên: mọi webhook/reconcile trên CÙNG đơn chạy tuần tự, không
  // có xung đột version -> không trả 4xx mà hub coi là non-retryable (DEAD).
  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM shop.orders WHERE order_code = ${orderCode} FOR UPDATE`;
      if (locked.length === 0) return { status: 'ORDER_NOT_FOUND' };
      if (await tx.processedHubEvent.findUnique({ where: { eventId } })) return { status: 'DUPLICATE' };
      const order = await tx.order.findUniqueOrThrow({ where: { orderCode } });
      await tx.processedHubEvent.create({ data: { eventId, orderId: order.id, amount: BigInt(amount) } });
      const next = applyPayment(order, BigInt(amount));
      // Phòng thủ thêm (đã khoá hàng nên lẽ ra không xảy ra): lệch version -> rollback cả event-id
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: { status: next.status, paidAmount: next.paidAmount, version: { increment: 1 } },
      });
      if (updated.count === 0) throw new Error('VERSION_CONFLICT');
      return { status: next.outcome, paidAmount: Number(next.paidAmount) };
    });
    if (result.status === 'LATE_PAYMENT' || result.status === 'EXTRA_PAYMENT') {
      logger.warn({ orderCode, amount, eventId }, `[Shop] ${result.status}: tiền về đơn đã đóng, cần đối soát/hoàn tiền`);
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

// 5. Đối soát: đơn PENDING quá 15 phút -> EXPIRED. UNDERPAID giữ nguyên (đã có tiền vào).
async function expireStaleOrders() {
  const { count } = await prisma.order.updateMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - EXPIRE_AFTER_MS) } },
    data: { status: 'EXPIRED', version: { increment: 1 } },
  });
  if (count > 0) logger.info({ count }, '[Shop] Reconcile: chuyển đơn quá hạn sang EXPIRED');
  return count;
}

// POST /api/internal/reconcile — gọi bởi GitHub Actions (deployed, ADR-022), bắt buộc X-Internal-Token
app.post('/api/internal/reconcile', async (req: Request, res: Response) => {
  const token = req.headers['x-internal-token'];
  if (!INTERNAL_TOKEN) return res.status(503).json({ error: 'INTERNAL_TOKEN chưa được cấu hình' });
  if (typeof token !== 'string' || !timingSafeCompare(token, INTERNAL_TOKEN)) {
    return res.status(401).json({ error: 'Sai X-Internal-Token' });
  }
  try {
    res.json({ expiredCount: await expireStaleOrders() });
  } catch (err: any) {
    logger.error({ err: err?.message }, '[Shop] Lỗi reconcile');
    res.status(500).json({ error: 'Reconcile thất bại' });
  }
});

// Local: tự reconcile định kỳ (docker-compose đặt RECONCILE_INTERVAL_MS)
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 0);
if (RECONCILE_INTERVAL_MS > 0) {
  setInterval(() => expireStaleOrders().catch((e) => logger.error({ err: e?.message }, '[Shop] Reconcile lỗi')), RECONCILE_INTERVAL_MS);
}

app.listen(PORT, () => {
  logger.info(`🛒 Demo Shop API đang chạy trên cổng ${PORT} (trần ~300 dòng)`);
});
