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

describe('traceFromHeaders — worker đọc ngữ cảnh (LOGGING.md §4)', () => {
  const { traceFromHeaders } = require('../src/trace-context');
  const corr = '3f2a9c1e-5b7d-4a08-b6c1-d2e3f4a5b6c7';
  const tid = '3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7';

  it('có traceparent hợp lệ -> propagated, giữ trace_id, span mới, parent là span cũ', () => {
    const t = traceFromHeaders({ traceparent: `00-${tid}-${'a'.repeat(16)}-01` }, 'whatever');
    expect(t).toMatchObject({ traceId: tid, origin: 'propagated', parentSpanId: 'a'.repeat(16) });
    expect(t.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(t.spanId).not.toBe('a'.repeat(16));
  });
  it('không header nhưng correlationId là UUID -> correlation (cùng trace_id); không gì cả -> orphan, không ném', () => {
    expect(traceFromHeaders({}, corr)).toMatchObject({ traceId: tid, origin: 'correlation' });
    const o = traceFromHeaders(undefined, 'corr-1');
    expect(o.origin).toBe('orphan');
    expect(o.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceFromHeaders({ traceparent: 'rác' }, undefined).origin).toBe('orphan');
  });
  it('x-replay-of hợp lệ được chuyển thành replayOf; rác bị bỏ', () => {
    expect(traceFromHeaders({ 'x-replay-of': tid }, corr).replayOf).toBe(tid);
    expect(traceFromHeaders({ 'x-replay-of': 'zzz' }, corr).replayOf).toBeUndefined();
  });
});

describe('replayTraceFields — replay = trace mới + link gốc', () => {
  const { replayTraceFields } = require('../src/trace-context');
  const corr = '3f2a9c1e-5b7d-4a08-b6c1-d2e3f4a5b6c7';
  it('trace_id MỚI khác gốc, replayOf = trace_id gốc; correlationId lạ -> không replayOf nhưng vẫn có trace mới', () => {
    const r = replayTraceFields(corr);
    expect(r.replayOf).toBe('3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7');
    expect(parseTraceparent(r.traceparent)!.traceId).not.toBe(r.replayOf);
    expect(replayTraceFields('corr-1').replayOf).toBeUndefined();
    expect(parseTraceparent(replayTraceFields('corr-1').traceparent)).not.toBeNull();
  });
});
