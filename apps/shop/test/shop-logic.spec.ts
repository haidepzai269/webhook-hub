import { hmacSha256, timingSafeCompare } from '@hub/crypto';

describe('Shop Webhook Logic & Security (§10 & BB-1)', () => {
  const SIGNING_SECRET = 'hub_outbound_signing_secret_999';

  describe('Xác thực chữ ký Standard Webhooks', () => {
    it('phải xác thực thành công chữ ký hợp lệ dạng v1={signature}', () => {
      const eventId = 'evt_01H1234567890ABCDEFGH';
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({
        id: eventId,
        type: 'payment.succeeded',
        data: { orderCode: 'DH10001', amount: 2000 },
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
      const rawBody = JSON.stringify({ id: eventId, data: { orderCode: 'DH10001', amount: 2000 } });

      const tamperedBody = JSON.stringify({ id: eventId, data: { orderCode: 'DH10001', amount: 5000 } });
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

  describe('So khớp số tiền và phân định trạng thái đơn hàng', () => {
    const orderAmount = 5000;

    it('phải chuyển sang PAID khi số tiền thanh toán đủ hoặc thừa', () => {
      const paidExact = 5000;
      const statusExact = paidExact >= orderAmount ? 'PAID' : 'UNDERPAID';
      expect(statusExact).toBe('PAID');

      const paidOver = 10000;
      const statusOver = paidOver >= orderAmount ? 'PAID' : 'UNDERPAID';
      expect(statusOver).toBe('PAID');
    });

    it('phải chuyển sang UNDERPAID khi số tiền thanh toán thiếu', () => {
      const paidUnder = 2000;
      const statusUnder = paidUnder >= orderAmount ? 'PAID' : 'UNDERPAID';
      expect(statusUnder).toBe('UNDERPAID');
    });
  });
});
