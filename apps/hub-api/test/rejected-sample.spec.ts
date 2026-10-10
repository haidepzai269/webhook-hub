import {
  REJECTED_BODY_MAX_BYTES,
  REJECTED_MAX_PER_MINUTE,
  RejectedRecordLimiter,
  sampleRejectedBody,
} from '../src/modules/ingest/rejected-sample';

describe('Request ký sai chỉ lưu mẫu có giới hạn (S1-4)', () => {
  it('body > 4KB -> bodyRaw cắt đúng 4KB, body chỉ là bản xem trước, meta ghi truncated', () => {
    const big = Buffer.from(JSON.stringify({ pad: 'x'.repeat(100_000) }));
    const s = sampleRejectedBody(big, JSON.parse(big.toString()));
    expect(s.bodyRaw.length).toBe(REJECTED_BODY_MAX_BYTES);
    expect(JSON.stringify(s.body).length).toBeLessThan(REJECTED_BODY_MAX_BYTES + 100);
    expect(s.meta).toEqual({ bodyTruncated: true, originalBytes: big.length });
  });

  it('body nhỏ -> giữ nguyên', () => {
    const small = Buffer.from('{"a":1}');
    const s = sampleRejectedBody(small, { a: 1 });
    expect(s.bodyRaw.equals(small)).toBe(true);
    expect(s.body).toEqual({ a: 1 });
    expect(s.meta.bodyTruncated).toBe(false);
  });

  it('tối đa 20 bản ghi/phút/source; source khác không bị ảnh hưởng; sang phút mới thì mở lại', () => {
    const limiter = new RejectedRecordLimiter();
    const t0 = 1_000_000;
    const results = Array.from({ length: 50 }, (_, i) => limiter.tryAcquire('src-1', t0 + i * 100));
    expect(results.filter(Boolean)).toHaveLength(REJECTED_MAX_PER_MINUTE);
    expect(limiter.tryAcquire('src-2', t0 + 5000)).toBe(true);
    expect(limiter.tryAcquire('src-1', t0 + 60_000)).toBe(true);
  });
});
