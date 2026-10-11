import { PayOS } from '@payos/node';
import { PayosAdapter, isPayosConfirmProbe } from '../src/payos.adapter';
import { ctx } from './fixtures';

/**
 * KQ1 (SPEC-ket-noi §5.1 + §11, ADR KQ1): request kiểm tra mà PayOS bắn lúc `confirm-webhook` = bộ mẫu CỐ ĐỊNH của tài liệu
 * PayOS (bằng chứng production 2026-10-11: orderCode 123, amount 3000, description "VQRIO123", reference "TF230204212323",
 * ký bằng checksumKey thật). Body dưới đây dựng lại đúng mẫu tài liệu; chữ ký tính bằng SDK chính chủ với key test.
 */
const KEY = 'checksum-key-for-test-kq1-1234567890';
const sdk = new PayOS({ clientId: 'x', apiKey: 'x', checksumKey: KEY });

const SAMPLE_DATA = {
  orderCode: 123,
  amount: 3000,
  description: 'VQRIO123',
  accountNumber: '12345678',
  reference: 'TF230204212323',
  transactionDateTime: '2023-02-04 18:25:00',
  currency: 'VND',
  paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
  code: '00',
  desc: 'Thành công',
  counterAccountBankId: '',
  counterAccountBankName: '',
  counterAccountName: '',
  counterAccountNumber: '',
  virtualAccountName: '',
  virtualAccountNumber: '',
};

async function signedReq(data: Record<string, unknown>, key = KEY) {
  const signature = await sdk.crypto.createSignatureFromObj(data, key);
  // Bytes như PayOS gửi (thứ tự khoá của tài liệu); HMAC tính trên `data`, adapter kiểm trên body đã parse từ rawBody.
  const raw = JSON.stringify({ code: '00', desc: 'success', success: true, data, signature });
  return { provider: 'payos' as const, sourceKey: 'src_payos_main', headers: { 'content-type': 'application/json' }, rawBody: Buffer.from(raw), body: JSON.parse(raw) };
}

describe('KQ1 — PayOS confirm probe (bộ mẫu cố định)', () => {
  const a = new PayosAdapter();

  it('[KN:U16] (phần a) đúng mẫu tài liệu, ký hợp lệ -> verify qua; normalize ra payos.webhook_test normalized:false probe:true, KHÔNG payment.*', async () => {
    const req = await signedReq(SAMPLE_DATA);
    expect(await a.verify(req, [KEY])).toBe(true);
    expect(isPayosConfirmProbe(req.body)).toBe(true);
    const events = a.normalize(req, ctx);
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.type).toBe('payos.webhook_test');
    expect(e.normalized).toBe(false);
    expect(e.probe).toBe(true);
    expect(e.data).toEqual({ raw: req.body });
    expect(events.some((x) => x.type.startsWith('payment.'))).toBe(false);
  });

  it.each([
    ['orderCode khác', { orderCode: 124 }],
    ['orderCode là chuỗi "123"', { orderCode: '123' }],
    ['reference khác (giao dịch thật orderCode 123)', { reference: 'FT26284123456' }],
    ['description khác', { description: 'DH123 thanh toan' }],
  ])('[KN:U16] (phần b) chỉ khớp một phần bộ ba — %s -> vẫn là giao dịch thật payment.received', async (_n, patch) => {
    const req = await signedReq({ ...SAMPLE_DATA, ...patch });
    expect(await a.verify(req, [KEY])).toBe(true);
    expect(isPayosConfirmProbe(req.body)).toBe(false);
    const [e] = a.normalize(req, ctx);
    expect(e.type).toBe('payment.received');
    expect(e.normalized).toBe(true);
    expect(e.probe).toBeUndefined();
  });

  it('[KN:U16] (phần c) chữ ký SAI trên đúng mẫu -> verify từ chối (nhận diện chỉ chạy trên raw ACCEPTED, sau verify)', async () => {
    const req = await signedReq(SAMPLE_DATA, 'khoa-khac-khoa-khac-khoa-khac-123456');
    expect(await a.verify(req, [KEY])).toBe(false);
  });

  it('[KN:U16] (phần d) PayOS kiểm lại (kết nối lại) -> CÙNG khoá chống trùng, ACK trùng là 200 (không 409/4xx)', async () => {
    const r1 = await signedReq(SAMPLE_DATA);
    const r2 = await signedReq(SAMPLE_DATA);
    expect(a.extractIdempotencyKey(r1)).toBe('payos:123:TF230204212323');
    expect(a.extractIdempotencyKey(r2)).toBe(a.extractIdempotencyKey(r1));
    const ack = a.buildAck({ accepted: true, isDuplicate: true, status: 200 } as any);
    expect(ack.status).toBe(200);
    expect((ack.body as any).code).toBe('00');
  });

  it('isPayosConfirmProbe chịu được body lạ (null, thiếu data, data không phải object)', () => {
    for (const b of [null, undefined, {}, { data: null }, { data: 'x' }, 'str', 123]) expect(isPayosConfirmProbe(b)).toBe(false);
  });
});
