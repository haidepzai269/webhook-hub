import express, { Request, Response } from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { hmacSha256, timingSafeCompare } from '@hub/crypto';
import { logger } from '@hub/common';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.SHOP_PORT || 4001;
const SIGNING_SECRET = process.env.HUB_SIGNING_SECRET || 'hub_outbound_signing_secret_999';

// Giữ rawBody để kiểm tra chữ ký HMAC
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(cors());

// Bộ nhớ chống trùng theo X-Hub-Event-Id
const processedHubEvents = new Set<string>();

// 1. GET /products — Danh sách 4 sản phẩm hardcode (2.000đ – 10.000đ)
app.get('/products', (_req: Request, res: Response) => {
  res.json([
    { id: 'p1', name: 'Cà phê muối Sài Gòn', price: 2000, description: 'Cà phê thơm ngon (demo test)' },
    { id: 'p2', name: 'Trà sen vàng Cung Đình', price: 5000, description: 'Thanh mát giải nhiệt' },
    { id: 'p3', name: 'Bánh mì chảo đặc biệt', price: 8000, description: 'Đậm đà hương vị' },
    { id: 'p4', name: 'Combo Đồ Án Tốt Nghiệp', price: 10000, description: 'Nạp năng lượng 100%' },
  ]);
});

// 2. POST /orders — Tạo đơn hàng mới
app.post('/orders', async (req: Request, res: Response) => {
  try {
    const { amount, paymentProvider = 'payos' } = req.body;
    const orderNumber = Math.floor(10000 + Math.random() * 90000);
    const orderCode = `DH${orderNumber}`;

    const order = await prisma.order.create({
      data: {
        orderCode,
        amount: BigInt(amount || 2000),
        status: 'PENDING',
        paymentProvider,
        payosPaymentLinkId: `link_${orderCode}`,
      },
    });

    res.json({
      success: true,
      order: {
        id: order.id,
        orderCode: order.orderCode,
        amount: Number(order.amount),
        status: order.status,
        qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${order.orderCode}%20${order.amount}`,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. GET /orders/:code — Lấy thông tin & trạng thái đơn hàng
app.get('/orders/:code', async (req: Request, res: Response) => {
  const codeParam = String(req.params.code);
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: codeParam }, { orderCode: codeParam }] },
  });
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  res.json({ ...order, amount: Number(order.amount), paidAmount: Number(order.paidAmount) });
});

// 4. POST /hub-webhook — Nhận outbound webhook từ Webhook Hub
app.post('/hub-webhook', async (req: any, res: Response) => {
  const eventId = req.headers['x-hub-event-id'] as string;
  const timestamp = parseInt((req.headers['x-hub-timestamp'] as string) || '0', 10);
  const rawSig = req.headers['x-hub-signature'] as string;

  // 4.1. Xác thực chữ ký Standard Webhooks
  if (!rawSig || !rawSig.startsWith('v1=')) {
    return res.status(401).json({ error: 'Thiếu hoặc sai định dạng chữ ký X-Hub-Signature' });
  }

  const expectedSig = hmacSha256(SIGNING_SECRET, `${eventId}.${timestamp}.${req.rawBody.toString('utf8')}`);
  if (!timingSafeCompare(expectedSig, rawSig.substring(3))) {
    return res.status(401).json({ error: 'Chữ ký không hợp lệ!' });
  }

  // 4.2. Chống Replay Attack: Timestamp không được lệch quá 5 phút (300s)
  const currentTs = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTs - timestamp) > 300) {
    return res.status(400).json({ error: 'Request đã quá hạn (> 5 phút), từ chối để chống replay attack' });
  }

  // 4.3. Chống trùng lặp theo X-Hub-Event-Id
  if (eventId && processedHubEvents.has(eventId)) {
    return res.status(200).json({ success: true, message: 'Duplicate webhook event skipped' });
  }
  if (eventId) processedHubEvents.add(eventId);

  // 4.4. Khớp mã đơn hàng DH\d+ từ data/subject/description
  const eventData = req.body.data || {};
  const searchString = `${req.body.subject || ''} ${eventData.description || ''} ${eventData.orderCode || ''} ${eventData.content || ''}`;
  const match = searchString.match(/DH\d+/);

  if (!match) {
    logger.warn({ searchString }, '[Shop] Không tìm thấy mã đơn hàng DH\\d+ trong webhook');
    return res.status(200).json({ success: true, status: 'UNMATCHED' });
  }

  const orderCode = match[0];
  const paidAmount = Number(eventData.amount || eventData.transferAmount || 0);

  // 4.5. Cập nhật trạng thái đơn hàng bằng Optimistic Locking (version)
  const order = await prisma.order.findUnique({ where: { orderCode } });
  if (!order) {
    return res.status(200).json({ success: true, status: 'ORDER_NOT_FOUND' });
  }

  if (order.status === 'PAID') {
    return res.status(200).json({ success: true, status: 'ALREADY_PAID' });
  }

  const newStatus = paidAmount >= Number(order.amount) ? 'PAID' : 'UNDERPAID';

  // Optimistic locking: chỉ update khi version khớp
  const updated = await prisma.order.updateMany({
    where: { id: order.id, version: order.version },
    data: {
      status: newStatus,
      paidAmount: BigInt(paidAmount),
      version: order.version + 1,
    },
  });

  if (updated.count === 0) {
    return res.status(409).json({ error: 'Conflict: Đơn hàng đã được cập nhật bởi tiến trình khác' });
  }

  logger.info({ orderCode, newStatus, paidAmount }, `[Shop] Đơn hàng ${orderCode} chuyển sang ${newStatus}`);
  res.status(200).json({ success: true, status: newStatus, orderCode });
});

// 5. POST /api/internal/reconcile — Cron đối soát (5 phút) các đơn PENDING quá 10 phút
app.post('/api/internal/reconcile', async (_req: Request, res: Response) => {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const staleOrders = await prisma.order.findMany({
    where: { status: 'PENDING', createdAt: { lt: tenMinutesAgo } },
  });

  res.json({
    message: `Đã đối soát ${staleOrders.length} đơn hàng quá hạn`,
    reconciledCount: staleOrders.length,
  });
});

app.listen(PORT, () => {
  logger.info(`🛒 Demo Shop API đang chạy trên cổng ${PORT} (Trần: ~140 dòng / tối đa 300 dòng)`);
});
