import {
  TRAFFIC_OUTCOMES,
  TRAFFIC_RANGES,
  TRAFFIC_RANGE_SPEC,
  TrafficBucket,
  TrafficInsight,
  TrafficOutcomeName,
  TrafficRange,
  TrafficTopIp,
  buildTrafficInsight,
} from '@hub/common';
import { PrismaService } from '@hub/database';
import { hubError } from '../errors/hub-error';
import { assertFlatQuery, badParam } from '../api/list-params';

/**
 * EG5 (SPEC-chong-qua-tai §6.3, ADR-181): logic của `GET /api/v1/projects/:projectId/sources/:sourceId/traffic` — tách khỏi
 * controller để test bằng store giả và Postgres thật. Mọi truy vấn qua `forTenant(projectId)` (BB-5, RLS): source của
 * project khác -> 404 như không tồn tại. Không chạm Redis. `blockedNow` lấy từ hộp phạt của INSTANCE đang trả lời (ước lượng).
 */
export type TrafficStore = Pick<PrismaService, 'forTenant'>;
export const TRAFFIC_TOP_IPS = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrafficResponse {
  range: TrafficRange;
  bucketSeconds: number;
  buckets: TrafficBucket[];
  topIps: TrafficTopIp[];
  insight: TrafficInsight;
  blockedNow: { ip: string; remainingSec: number }[];
  /** `blockedNow` chỉ là của instance hub-api đang trả lời (§6.2) — nhiều instance thì là ước lượng. */
  blockedNowScope: 'this_instance';
}

export function parseTrafficRange(q: { range?: string } | undefined): TrafficRange {
  assertFlatQuery(q);
  const r = q?.range ?? '1h';
  if (!(TRAFFIC_RANGES as readonly string[]).includes(r)) throw badParam('range', `range chỉ nhận ${TRAFFIC_RANGES.join(', ')}`);
  return r as TrafficRange;
}

const emptyBucket = (t: number): TrafficBucket =>
  ({ t: new Date(t).toISOString(), ...Object.fromEntries(TRAFFIC_OUTCOMES.map((k) => [k, 0])) }) as TrafficBucket;

export async function getSourceTraffic(
  store: TrafficStore,
  projectId: string,
  sourceId: string,
  q: { range?: string } | undefined,
  blockedNow: (sourceId: string) => { ip: string; remainingSec: number }[],
  now = new Date(),
): Promise<TrafficResponse> {
  const range = parseTrafficRange(q);
  if (!UUID_RE.test(sourceId)) throw hubError('not_found');
  const repo = store.forTenant(projectId);
  const source = await repo.findSourceById(sourceId, { includeArchived: true });
  if (!source) throw hubError('not_found');

  const { spanMs, bucketSec } = TRAFFIC_RANGE_SPEC[range];
  const step = bucketSec * 1000;
  const start = Math.floor((now.getTime() - spanMs) / step) * step + step; // đúng `span / bucket` cột, cột cuối chứa "bây giờ"
  const since = new Date(start);
  const [rows, ips] = await Promise.all([repo.sourceTrafficBuckets(sourceId, since, bucketSec), repo.sourceTrafficTopIps(sourceId, since, TRAFFIC_TOP_IPS)]);

  // Lấp cột trống bằng 0 — biểu đồ liền mạch, cột không có request vẫn hiện.
  const buckets: TrafficBucket[] = [];
  const index = new Map<number, TrafficBucket>();
  for (let t = start; t <= now.getTime(); t += step) {
    const b = emptyBucket(t);
    buckets.push(b);
    index.set(t, b);
  }
  for (const r of rows) {
    const b = index.get(new Date(r.t).getTime());
    if (b && (TRAFFIC_OUTCOMES as readonly string[]).includes(r.outcome)) b[r.outcome as TrafficOutcomeName] += Number(r.n);
  }
  const topIps: TrafficTopIp[] = ips.map((r) => ({ ip: r.ip, count: Number(r.count), rejected: Number(r.rejected), lastSeen: new Date(r.lastSeen).toISOString() }));
  let blocked: { ip: string; remainingSec: number }[] = [];
  try {
    blocked = blockedNow(sourceId);
  } catch {
    /* hộp phạt lỗi -> coi như không có (fail-open) */
  }
  return {
    range,
    bucketSeconds: bucketSec,
    buckets,
    topIps,
    insight: buildTrafficInsight({ sourceId, range, buckets, topIps }),
    blockedNow: blocked,
    blockedNowScope: 'this_instance',
  };
}
