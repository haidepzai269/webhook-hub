import { TRAFFIC_INSIGHT, TrafficBucket, buildTrafficInsight } from '../src/traffic';

/** EG5 (SPEC-chong-qua-tai §6.2): nhận định `I-traffic` — hàm thuần `code + facts`, câu chữ ở web. */
const b = (o: Partial<TrafficBucket> = {}): TrafficBucket => ({ t: '2026-10-12T08:00:00.000Z', ACCEPTED: 0, DUPLICATE: 0, REJECTED: 0, RATE_LIMITED: 0, BLOCKED: 0, ...o });
const ip = (addr: string, count: number) => ({ ip: addr, count, rejected: 0, lastSeen: '2026-10-12T08:00:00.000Z' });

describe('EG5 nhận định lưu lượng', () => {
  it('[EG:T15] trả code + facts đúng ngưỡng; không có dữ liệu -> trạng thái trống', () => {
    // trống
    const empty = buildTrafficInsight({ sourceId: 's', range: '1h', buckets: [b(), b()], topIps: [] });
    expect(empty).toEqual({ code: 'I-traffic', level: 'ok', subjectType: 'source', subjectId: 's', facts: { range: '1h', state: 'empty', total: 0, rejected: 0, rejectedPct: 0, rateLimited: 0, blocked: 0 } });

    // ví dụ của spec: 1.240 request · 31% sai chữ ký · phần lớn từ 1 IP
    const spec = buildTrafficInsight({ sourceId: 's', range: '1h', buckets: [b({ ACCEPTED: 856, REJECTED: 384 })], topIps: [ip('203.0.113.7', 700), ip('1.1.1.1', 10)] });
    expect(spec).toMatchObject({ level: 'warning', facts: { state: 'attention', total: 1240, rejected: 384, rejectedPct: 31, dominantIp: '203.0.113.7', dominantIpPct: 56 } });

    // sát ngưỡng: 24% sai chữ ký -> bình thường; 25% -> chú ý
    expect(buildTrafficInsight({ sourceId: 's', range: '24h', buckets: [b({ ACCEPTED: 76, REJECTED: 24 })], topIps: [] }).facts.state).toBe('normal');
    expect(buildTrafficInsight({ sourceId: 's', range: '24h', buckets: [b({ ACCEPTED: 75, REJECTED: 25 })], topIps: [] }).facts.state).toBe('attention');
    // ít hơn minTotal request: 100% sai chữ ký vẫn chưa kết luận theo tỷ lệ, và không nêu IP áp đảo
    const few = buildTrafficInsight({ sourceId: 's', range: '1h', buckets: [b({ REJECTED: TRAFFIC_INSIGHT.minTotal - 1 })], topIps: [ip('9.9.9.9', 19)] });
    expect(few.facts).toMatchObject({ state: 'normal', rejectedPct: 100 });
    expect(few.facts.dominantIp).toBeUndefined();
    // có RATE_LIMITED hoặc BLOCKED -> luôn chú ý (kể cả ít request)
    expect(buildTrafficInsight({ sourceId: 's', range: '1h', buckets: [b({ ACCEPTED: 3, RATE_LIMITED: 1 })], topIps: [] }).level).toBe('warning');
    expect(buildTrafficInsight({ sourceId: 's', range: '1h', buckets: [b({ BLOCKED: 2 })], topIps: [] }).facts).toMatchObject({ state: 'attention', blocked: 2 });
    // IP < 50% -> không nêu
    expect(buildTrafficInsight({ sourceId: 's', range: '7d', buckets: [b({ ACCEPTED: 100 })], topIps: [ip('2.2.2.2', 49)] }).facts.dominantIp).toBeUndefined();
  });
});
