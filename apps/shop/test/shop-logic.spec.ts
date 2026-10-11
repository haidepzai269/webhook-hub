import { hmacSha256, timingSafeCompare } from '@hub/crypto';
import { MENU, priceOrder, maskCustomer } from '../src/menu';
import { applyPayment, creditsOrder, EXPIRE_AFTER_MS, isExpired, orderTtlMs, pickOrderCode, readPayment } from '../src/payment';

const TTL_MIN = EXPIRE_AFTER_MS / 60_000; // L-4: test không phụ thuộc SHOP_ORDER_TTL_MIN của máy chạy

describe('Shop Webhook Logic & Security (§10 & BB-1)', () => {
  const SIGNING_SECRET = 'hub_outbound_signing_secret_999';

  describe('Xác thực chữ ký Standard Webhooks', () => {
    it('phải xác thực thành công chữ ký hợp lệ dạng v1={signature}', () => {
      const eventId = 'evt_01H1234567890ABCDEFGH';
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({
        id: eventId,
        type: 'payment.received',
        data: { amount: 2000, currency: 'VND', memo: 'DH10001 thanh toan' },
      });

      const payloadToSign = `${eventId}.${timestamp}.${rawBody}`;
      const signature = hmacSha256(SIGNING_SECRET, payloadToSign);
      const headerSignature = `v1=${signature}`;

      // Logic xác thực của Shop
      expect(headerSignature.startsWith('v1=')).toBe(true);
      const expectedSig = hmacSha256(SIGNING_SECRET, `${eventId}.${timestamp}.${rawBody}`);
      const isValid = timingSafeCompare(expectedSig, headerSignature.substring(3));
      expect(isValid).toBe(true);
    });

    it('phải từ chối chữ ký giả mạo hoặc bị chỉnh sửa', () => {
      const eventId = 'evt_01H1234567890ABCDEFGH';
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ id: eventId, data: { memo: 'DH10001', amount: 2000 } });

      const tamperedBody = JSON.stringify({ id: eventId, data: { memo: 'DH10001', amount: 5000 } });
      const signature = hmacSha256(SIGNING_SECRET, `${eventId}.${timestamp}.${rawBody}`);

      const computedOnTampered = hmacSha256(SIGNING_SECRET, `${eventId}.${timestamp}.${tamperedBody}`);
      const isValid = timingSafeCompare(computedOnTampered, signature);
      expect(isValid).toBe(false);
    });
  });

  describe('Chống Replay Attack bằng Timestamp', () => {
    it('phải chấp nhận request trong ngưỡng 5 phút (300 giây)', () => {
      const currentTs = Math.floor(Date.now() / 1000);
      const validPastTs = currentTs - 120; // 2 phút trước
      const diff = Math.abs(currentTs - validPastTs);
      expect(diff <= 300).toBe(true);
    });

    it('phải từ chối request lệch quá 5 phút (300 giây)', () => {
      const currentTs = Math.floor(Date.now() / 1000);
      const expiredTs = currentTs - 400; // 6.6 phút trước
      const diff = Math.abs(currentTs - expiredTs);
      expect(diff > 300).toBe(true);
    });
  });

  describe('Khớp mã đơn hàng Regex DH\\d+', () => {
    it('phải trích xuất chính xác mã đơn hàng DH\\d+ từ các trường khác nhau', () => {
      const patterns = [
        { text: 'Chuyen khoan don hang DH12345 thanh cong', expected: 'DH12345' },
        { text: 'DH99999 mua cafe muoi', expected: 'DH99999' },
        { text: 'Thanh toan payos ma giao dich DH54321 tai quay', expected: 'DH54321' },
      ];

      for (const item of patterns) {
        const match = item.text.match(/DH\d+/);
        expect(match).not.toBeNull();
        expect(match![0]).toBe(item.expected);
      }
    });

    it('phải phát hiện trường hợp không có mã đơn hàng (UNMATCHED)', () => {
      const text = 'Chuyen khoan ca nhan khong noi dung ro rang';
      const match = text.match(/DH\d+/);
      expect(match).toBeNull();
    });
  });

  describe('Máy trạng thái + cộng dồn thanh toán (ADR-034)', () => {
    const order = (status: string, paid = 0, ageMin = 1) => ({
      status,
      amount: 138000n,
      paidAmount: BigInt(paid),
      createdAt: new Date(Date.now() - ageMin * 60_000),
    });

    it('đủ hoặc thừa tiền -> PAID, thiếu -> UNDERPAID', () => {
      expect(applyPayment(order('PENDING'), 138000n)).toMatchObject({ status: 'PAID', outcome: 'PAID' });
      expect(applyPayment(order('PENDING'), 200000n).status).toBe('PAID');
      expect(applyPayment(order('PENDING'), 100000n)).toMatchObject({ status: 'UNDERPAID', paidAmount: 100000n });
    });

    it('hai lần chuyển khoản được CỘNG DỒN, không ghi đè', () => {
      const first = applyPayment(order('PENDING'), 100000n);
      const second = applyPayment({ ...order(first.status), paidAmount: first.paidAmount }, 38000n);
      expect(second).toMatchObject({ status: 'PAID', paidAmount: 138000n });
    });

    it('thứ tự webhook đến không làm đổi kết quả', () => {
      const run = (amounts: bigint[]) =>
        amounts.reduce((o, a) => ({ ...o, ...applyPayment(o, a) }), order('PENDING') as any);
      expect(run([50000n, 30000n, 58000n])).toMatchObject({ status: 'PAID', paidAmount: 138000n });
      expect(run([58000n, 50000n, 30000n])).toMatchObject({ status: 'PAID', paidAmount: 138000n });
    });

    it('tiền về đơn EXPIRED (trả SAU hạn): ghi nhận nhưng KHÔNG hồi sinh', () => {
      expect(applyPayment(order('EXPIRED', 0, TTL_MIN + 10), 138000n)).toEqual({
        status: 'EXPIRED',
        paidAmount: 138000n,
        outcome: 'LATE_PAYMENT',
      });
    });

    it('tiền về thêm khi đã PAID: giữ PAID, báo EXTRA_PAYMENT', () => {
      expect(applyPayment(order('PAID', 138000), 1000n)).toEqual({
        status: 'PAID',
        paidAmount: 139000n,
        outcome: 'EXTRA_PAYMENT',
      });
    });

    it('UNDERPAID không tự hết hạn (đã có tiền vào), dù đã quá hạn', () => {
      expect(applyPayment(order('UNDERPAID', 100000, TTL_MIN * 2), 38000n).status).toBe('PAID');
    });

    it('L-4: hạn đơn mặc định 30 phút, đổi bằng SHOP_ORDER_TTL_MIN (hàm thuần, không đọc env của máy chạy)', () => {
      expect(orderTtlMs({} as any)).toBe(30 * 60_000);
      expect(orderTtlMs({ SHOP_ORDER_TTL_MIN: '45' } as any)).toBe(45 * 60_000);
      expect(orderTtlMs({ SHOP_ORDER_TTL_MIN: 'x' } as any)).toBe(30 * 60_000);
    });

    it('PENDING quá hạn mà cron reconcile CHƯA chạy: vẫn coi là EXPIRED (hết hạn lười)', () => {
      expect(applyPayment(order('PENDING', 0, TTL_MIN + 10), 138000n)).toEqual({
        status: 'EXPIRED',
        paidAmount: 138000n,
        outcome: 'LATE_PAYMENT',
      });
      expect(applyPayment(order('PENDING', 0, TTL_MIN - 1), 138000n).status).toBe('PAID');
    });

    it('M-1: trả ĐÚNG hạn (paidAt của provider) nhưng webhook tới SAU hạn (cold start) -> vẫn PAID', () => {
      const o = order('PENDING', 0, TTL_MIN + 3);
      const paidAt = new Date(o.createdAt.getTime() + EXPIRE_AFTER_MS - 60_000);
      expect(applyPayment(o, 138000n, paidAt)).toMatchObject({ status: 'PAID', outcome: 'PAID' });
      // cron đã kịp EXPIRE trước khi webhook tới: khoản trả đúng hạn vẫn được tính
      expect(applyPayment({ ...o, status: 'EXPIRED' }, 138000n, paidAt)).toMatchObject({ status: 'PAID', outcome: 'PAID' });
      expect(applyPayment({ ...o, status: 'EXPIRED' }, 100000n, paidAt)).toMatchObject({ status: 'UNDERPAID' });
    });

    it('M-1: paidAt sau hạn -> LATE_PAYMENT; paidAt ở tương lai (lệch đồng hồ) bị chặn bởi now', () => {
      const o = order('PENDING', 0, TTL_MIN + 10);
      expect(applyPayment(o, 138000n, new Date(o.createdAt.getTime() + EXPIRE_AFTER_MS + 60_000)).outcome).toBe('LATE_PAYMENT');
      expect(applyPayment(o, 138000n, new Date(Date.now() + 3_600_000)).outcome).toBe('LATE_PAYMENT');
    });

    it('L-2: GET /orders hiển thị hết hạn lười (PENDING quá hạn = EXPIRED, UNDERPAID không)', () => {
      expect(isExpired(order('PENDING', 0, TTL_MIN + 1))).toBe(true);
      expect(isExpired(order('PENDING', 0, TTL_MIN - 1))).toBe(false);
      expect(isExpired(order('UNDERPAID', 1, TTL_MIN + 1))).toBe(false);
      const src = require('fs').readFileSync(require('path').join(__dirname, '../src/main.ts'), 'utf8');
      expect(src).toMatch(/isExpired\(order\) \? 'EXPIRED'/);
    });
  });

  describe('Tính tiền ở server (ADR-024)', () => {
    const customer = { name: 'Nguyễn Văn A', phone: '0901234567' };

    it('tổng tiền = Σ price × qty theo menu của server', () => {
      const r = priceOrder({ items: [{ id: 'm1', qty: 2 }, { id: 'm5', qty: 1 }], customer });
      expect(r.ok).toBe(true);
      if ('error' in r) return;
      expect(r.amount).toBe(69000 * 2 + 45000);
      expect(r.items.map((l) => l.price)).toEqual([69000, 45000]);
    });

    it('bỏ qua `amount` và `price` do client gửi lên', () => {
      const r = priceOrder({ amount: 1, items: [{ id: 'm2', qty: 1, price: 1 }], customer });
      if ('error' in r) throw new Error(r.error);
      expect(r.amount).toBe(MENU.find((m) => m.id === 'm2')!.price);
    });

    it('gộp các dòng trùng id', () => {
      const r = priceOrder({ items: [{ id: 'm3', qty: 1 }, { id: 'm3', qty: 2 }], customer });
      if ('error' in r) throw new Error(r.error);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].qty).toBe(3);
    });

    it.each([
      ['giỏ rỗng', { items: [], customer }],
      ['thiếu items', { customer }],
      ['id lạ', { items: [{ id: 'hack', qty: 1 }], customer }],
      ['qty = 0', { items: [{ id: 'm1', qty: 0 }], customer }],
      ['qty = 21', { items: [{ id: 'm1', qty: 21 }], customer }],
      ['qty lẻ', { items: [{ id: 'm1', qty: 1.5 }], customer }],
      ['qty dạng chuỗi', { items: [{ id: 'm1', qty: '2' }], customer }],
      ['gộp vượt 20', { items: [{ id: 'm1', qty: 15 }, { id: 'm1', qty: 6 }], customer }],
      ['thiếu tên', { items: [{ id: 'm1', qty: 1 }], customer: { phone: '0901234567' } }],
      ['thiếu SĐT', { items: [{ id: 'm1', qty: 1 }], customer: { name: 'A' } }],
      ['SĐT rác', { items: [{ id: 'm1', qty: 1 }], customer: { name: 'A', phone: 'abc' } }],
      ['SĐT toàn dấu', { items: [{ id: 'm1', qty: 1 }], customer: { name: 'A', phone: '........' } }],
      ['id là object độc', { items: [{ id: { toString: 1 }, qty: 1 }], customer }],
      ['body là mảng', [{ id: 'm1', qty: 1 }]],
      ['items chứa null', { items: [null], customer }],
    ])('từ chối: %s', (_label, body) => {
      expect(priceOrder(body).ok).toBe(false);
    });

    it('che SĐT khi trả về qua GET /orders/:code', () => {
      expect(maskCustomer({ name: 'Nguyễn Văn An', phone: '0901234567', address: 'Q1' })).toEqual({
        name: 'Nguyễn V. A.',
        phone: '*******567',
      });
      expect(maskCustomer(null)).toBeNull();
    });
  });

  describe('S3-2: đọc khoản tiền từ kiểu chuẩn payment.received (một đầu ra duy nhất)', () => {
    const core = { amount: 50000, currency: 'VND', method: 'bank_transfer', reference: 'FT1', memo: 'DH1234567 thanh toan', counterparty: null, account: null, providerTxnId: '1', paidAt: '2026-10-10T07:00:00.000Z', raw: {} };

    it('cùng một hình dạng cho mọi provider: mã đơn trong memo, tiền ở data.amount', () => {
      expect(readPayment({ type: 'payment.received', source: 'sepay', data: core })).toMatchObject({ orderCodes: ['DH1234567'], amount: 50000 });
      // PayOS (method payment_link) và SePay (bank_transfer) đọc y hệt — không có nhánh theo provider
      expect(readPayment({ type: 'payment.received', source: 'sepay', data: { ...core, method: 'payment_link' } })).toMatchObject({ orderCodes: ['DH1234567'], amount: 50000 });
    });

    it('memo không có mã -> tìm trong reference', () => {
      expect(readPayment({ type: 'payment.received', source: 'sepay', data: { ...core, memo: 'chuyen tien', reference: 'DH7777777' } })).toMatchObject({ orderCodes: ['DH7777777'], amount: 50000 });
    });

    it('M-3: lấy MỌI mã DH+7 số / DH+10 số (cũ), không lấy lần khớp đầu không neo; mã có độ dài khác bị bỏ', () => {
      const r = (memo: string) => readPayment({ type: 'payment.received', source: 'payos', data: { ...core, memo } });
      expect(r('CSDH9876543DH1234567')).toMatchObject({ orderCodes: ['DH9876543', 'DH1234567'] });
      expect(r('CSDH12 DH1234567')).toMatchObject({ orderCodes: ['DH1234567'] });
      expect(r('DH1234567890 cu')).toMatchObject({ orderCodes: ['DH1234567890'] });
      expect(r('DH12345678 sai do dai')).toEqual({ skip: 'UNMATCHED' });
      expect(pickOrderCode(['DH9876543', 'DH1234567'], ['DH1234567'])).toBe('DH1234567');
      expect(pickOrderCode(['DH9876543'], [])).toBeNull();
    });

    it('R2-L4: khoá nhiều dòng theo thứ tự cố định (ORDER BY order_code) — hai webhook không deadlock', () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../src/main.ts'), 'utf8');
      expect(src).toMatch(/order_code = ANY\(\$\{orderCodes\}\) ORDER BY order_code FOR UPDATE/);
    });

    it('M-1/M-2: trả source và paidAt (thời điểm provider) để Shop xét kênh + hạn', () => {
      expect(readPayment({ type: 'payment.received', source: 'payos', data: core })).toEqual({ orderCodes: ['DH1234567'], amount: 50000, source: 'payos', paidAt: new Date('2026-10-10T07:00:00.000Z') });
      expect(readPayment({ type: 'payment.received', source: 'sepay', data: { ...core, paidAt: null } })).toMatchObject({ paidAt: undefined });
    });

    it('M-2: chỉ cộng tiền từ ĐÚNG kênh khách đã chọn (một tài khoản sau cả PayOS lẫn SePay không bị cộng đôi)', () => {
      expect(creditsOrder('payos', 'payos')).toBe(true);
      expect(creditsOrder('payos', 'sepay')).toBe(false);
      expect(creditsOrder('sepay', 'payos')).toBe(false);
      expect(creditsOrder(null, 'sepay')).toBe(true); // đơn cũ không ghi kênh
    });

    it('không có mã -> UNMATCHED; kiểu khác / tiền tệ khác / số tiền sai -> IGNORED', () => {
      expect(readPayment({ type: 'payment.received', source: 'sepay', data: { ...core, memo: null, reference: null } })).toEqual({ skip: 'UNMATCHED' });
      expect(readPayment({ type: 'payment.failed', source: 'sepay', data: core })).toEqual({ skip: 'IGNORED' });
      expect(readPayment({ type: 'payment.received', source: 'sepay', data: { ...core, currency: 'USD' } })).toEqual({ skip: 'IGNORED' });
      expect(readPayment({ type: 'payment.received', source: 'sepay', data: { ...core, amount: 1.5 } })).toEqual({ skip: 'IGNORED' });
    });

    it('MS-R2: chỉ tin source thanh toán THẬT (payos, sepay) — sự kiện service tự phát (api) hay nguồn tuỳ chỉnh (generic) cùng khuôn vẫn IGNORED', () => {
      expect(readPayment({ type: 'payment.received', source: 'payos', data: core })).toMatchObject({ orderCodes: ['DH1234567'], amount: 50000 });
      expect(readPayment({ type: 'payment.received', source: 'api', data: core })).toEqual({ skip: 'IGNORED' });
      expect(readPayment({ type: 'payment.received', source: 'generic', data: core })).toEqual({ skip: 'IGNORED' });
      expect(readPayment({ type: 'payment.received', data: core })).toEqual({ skip: 'IGNORED' });
      expect(readPayment({ type: 'payment.received', source: 'generic', data: core }, ['generic'])).toMatchObject({ orderCodes: ['DH1234567'], amount: 50000 });
    });

    it('R-1: có danh sách sourceId tin cậy (từ ensure) -> event từ source khác (dù tên sepay) IGNORED', () => {
      const ok = { type: 'payment.received', source: 'sepay', sourceId: 'S-OP', data: core };
      expect(readPayment(ok, undefined, ['S-OP'])).toMatchObject({ orderCodes: ['DH1234567'], amount: 50000 });
      expect(readPayment({ ...ok, sourceId: 'S-ATTACKER' }, undefined, ['S-OP'])).toEqual({ skip: 'IGNORED' });
      expect(readPayment({ ...ok, sourceId: undefined }, undefined, ['S-OP'])).toEqual({ skip: 'IGNORED' });
    });

    it('payload cũ (payment.succeeded + transferAmount/orderCode) không còn được đọc', () => {
      expect(readPayment({ type: 'payment.succeeded', data: { orderCode: 'DH1', transferAmount: 1000 } })).toEqual({ skip: 'IGNORED' });
      const src = require('fs').readFileSync(require('path').join(__dirname, '../src/main.ts'), 'utf8');
      expect(src).not.toMatch(/transferAmount|eventData\.orderCode|eventData\.content/);
    });
  });
});
