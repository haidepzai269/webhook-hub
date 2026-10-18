import { parseTraceparent, formatTraceparent, traceIdOf, correlationIdOf, newSpanId, newTraceId, childTraceparent } from '../src/trace-context';

describe('trace-context — W3C traceparent (LOGGING.md §4)', () => {
  const corr = '3f2a9c1e-5b7d-4a08-b6c1-d2e3f4a5b6c7';

  it('trace_id = correlationId bỏ dấu "-" (32 hex), và đảo ngược được', () => {
    expect(traceIdOf(corr)).toBe('3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7');
    expect(correlationIdOf('3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7')).toBe(corr);
    expect(traceIdOf('unknown')).toBeNull();
    expect(traceIdOf(undefined)).toBeNull();
  });

  it('format/parse khứ hồi; span_id 16 hex mới mỗi lần', () => {
    const t = traceIdOf(corr)!;
    const s = newSpanId();
    expect(s).toMatch(/^[0-9a-f]{16}$/);
    expect(newSpanId()).not.toBe(s);
    const tp = formatTraceparent(t, s);
    expect(tp).toBe(`00-${t}-${s}-01`);
    expect(parseTraceparent(tp)).toEqual({ traceId: t, spanId: s, flags: '01' });
  });

  it('từ chối traceparent sai khuôn (không bao giờ ném)', () => {
    for (const bad of [undefined, '', 'garbage', '00-xyz-abc-01', `00-${'0'.repeat(32)}-${'a'.repeat(16)}-01`, `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`, `ff-${'a'.repeat(32)}-${'a'.repeat(16)}-01`, `00-${'A'.repeat(32)}-${'a'.repeat(16)}-01`, 42 as any]) {
      expect(parseTraceparent(bad as any)).toBeNull();
    }
  });

  it('childTraceparent giữ trace_id, đổi span_id', () => {
    const parent = formatTraceparent(traceIdOf(corr)!, 'a'.repeat(16));
    const child = childTraceparent(parent)!;
    expect(parseTraceparent(child)!.traceId).toBe(traceIdOf(corr));
    expect(parseTraceparent(child)!.spanId).not.toBe('a'.repeat(16));
    expect(childTraceparent('bad')).toBeNull();
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
