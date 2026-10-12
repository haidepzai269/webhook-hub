/**
 * EG5 (SPEC-chong-qua-tai §6, ADR-181): hợp đồng của `GET /api/v1/projects/:p/sources/:id/traffic` + nhận định `I-traffic`.
 * Cùng khuôn với nhận định CB6 (`code + level + facts`, câu chữ dựng ở web theo ngôn ngữ). Hàm THUẦN — không I/O.
 */
export const TRAFFIC_OUTCOMES = ['ACCEPTED', 'DUPLICATE', 'REJECTED', 'RATE_LIMITED', 'BLOCKED'] as const;
export type TrafficOutcomeName = (typeof TRAFFIC_OUTCOMES)[number];

export const TRAFFIC_RANGES = ['1h', '24h', '7d'] as const;
export type TrafficRange = (typeof TRAFFIC_RANGES)[number];

/** Độ dài phạm vi và độ rộng một cột của biểu đồ: 1h theo phút, 24h gộp 5 phút, 7 ngày gộp 1 giờ (§6.2). */
export const TRAFFIC_RANGE_SPEC: Record<TrafficRange, { spanMs: number; bucketSec: number }> = {
  '1h': { spanMs: 3_600_000, bucketSec: 60 },
  '24h': { spanMs: 86_400_000, bucketSec: 300 },
  '7d': { spanMs: 7 * 86_400_000, bucketSec: 3_600 },
};

export type TrafficBucket = { t: string } & Record<TrafficOutcomeName, number>;

export interface TrafficTopIp {
  ip: string;
  count: number;
  rejected: number;
  lastSeen: string;
}

/** Ngưỡng của nhận định: dưới `minTotal` request thì không kết luận "đáng chú ý" theo tỷ lệ. */
export const TRAFFIC_INSIGHT = { minTotal: 20, rejectedPct: 25, dominantIpPct: 50 } as const;

export interface TrafficInsightFacts extends Record<string, unknown> {
  range: TrafficRange;
  /** `empty` = không có request nào trong phạm vi (trạng thái trống); `attention` = có điều cần xem; `normal` = khoẻ. */
  state: 'empty' | 'normal' | 'attention';
  total: number;
  rejected: number;
  rejectedPct: number;
  rateLimited: number;
  blocked: number;
  /** IP chiếm ≥ `dominantIpPct`% request (chỉ khi đủ `minTotal`). */
  dominantIp?: string;
  dominantIpPct?: number;
}

export interface TrafficInsight {
  code: 'I-traffic';
  level: 'ok' | 'info' | 'warning';
  subjectType: 'source';
  subjectId: string;
  facts: TrafficInsightFacts;
}

export function buildTrafficInsight(input: { sourceId: string; range: TrafficRange; buckets: TrafficBucket[]; topIps: TrafficTopIp[] }): TrafficInsight {
  const sum = (k: TrafficOutcomeName) => input.buckets.reduce((s, b) => s + (b[k] ?? 0), 0);
  const counts = Object.fromEntries(TRAFFIC_OUTCOMES.map((k) => [k, sum(k)])) as Record<TrafficOutcomeName, number>;
  const total = TRAFFIC_OUTCOMES.reduce((s, k) => s + counts[k], 0);
  const rejectedPct = total > 0 ? Math.round((counts.REJECTED / total) * 100) : 0;
  const facts: TrafficInsightFacts = {
    range: input.range,
    state: 'empty',
    total,
    rejected: counts.REJECTED,
    rejectedPct,
    rateLimited: counts.RATE_LIMITED,
    blocked: counts.BLOCKED,
  };
  if (total === 0) return { code: 'I-traffic', level: 'ok', subjectType: 'source', subjectId: input.sourceId, facts };
  const top = input.topIps[0];
  if (top && total >= TRAFFIC_INSIGHT.minTotal) {
    const pct = Math.round((top.count / total) * 100);
    if (pct >= TRAFFIC_INSIGHT.dominantIpPct) {
      facts.dominantIp = top.ip;
      facts.dominantIpPct = Math.min(100, pct);
    }
  }
  const badSignature = total >= TRAFFIC_INSIGHT.minTotal && rejectedPct >= TRAFFIC_INSIGHT.rejectedPct;
  const attention = badSignature || counts.RATE_LIMITED > 0 || counts.BLOCKED > 0;
  facts.state = attention ? 'attention' : 'normal';
  return { code: 'I-traffic', level: attention ? 'warning' : 'ok', subjectType: 'source', subjectId: input.sourceId, facts };
}
