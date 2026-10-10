import { PayosAdapter, SepayAdapter } from '../src';
import { ctx, payosSuccess, req, sepayTx } from './fixtures';

/**
 * U37 — luận điểm "vào nhiều kiểu, ra một kiểu": CÙNG một khoản 50.000đ đi qua PayOS và SePay
 * ra hai event có tập khoá `data` giống hệt nhau và cùng amount/currency.
 */
describe('U37 PayOS và SePay ra cùng hình dạng', () => {
  it('Object.keys(data) giống hệt; amount + currency bằng nhau', () => {
    const [p] = new PayosAdapter().normalize(req('payos', payosSuccess()), ctx);
    const [s] = new SepayAdapter().normalize(req('sepay', sepayTx()), ctx);
    expect(p.type).toBe(s.type);
    expect(Object.keys(p.data)).toEqual(Object.keys(s.data));
    expect(p.data.amount).toBe(s.data.amount);
    expect(p.data.currency).toBe(s.data.currency);
    expect(p.normalized && s.normalized).toBe(true);
  });
});
