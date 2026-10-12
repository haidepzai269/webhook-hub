/**
 * QT §5.3 (ADR-186): mức độ quan trọng do hub GỢI Ý — hàm THUẦN trên tín hiệu CHUNG của hub (trạng thái giao, tuổi, loại
 * bản ghi, cờ user đặt). KHÔNG đọc payload, KHÔNG xét provider (BB-1): "Thấp" là vì đã giao xong, không phải vì hub đoán
 * nghiệp vụ. Hub không biết event nào là thanh toán quan trọng; user tự gắn cờ "Giữ lâu" cho source đó.
 */
export const IMPORTANCES = ['junk', 'low', 'medium', 'high', 'keep'] as const;
export type Importance = (typeof IMPORTANCES)[number];

/** Mức có thể đặt dọn tự động (§5.4). "Cao" và "Giữ" KHÔNG có trong bảng policy. */
export const POLICY_IMPORTANCES = ['junk', 'low', 'medium'] as const;
export type PolicyImportance = (typeof POLICY_IMPORTANCES)[number];

export interface ImportanceRecord {
  /** `rejected_sample` = mẫu request REJECTED (≤4KB, ADR-045); `event` = event đã nhận. */
  kind: 'event' | 'rejected_sample';
  /** Lần replay gần nhất (nếu có). Replay trong 24h -> "Cao". */
  lastReplayAt?: Date | null;
  /** Có thể có — hàm KHÔNG đọc (test QT:T17 truyền null vẫn ra cùng kết quả). */
  payload?: unknown;
}

export interface ImportanceDelivery {
  status: 'PENDING' | 'DELIVERING' | 'RETRYING' | 'SUCCEEDED' | 'DEAD' | string;
}

export interface ImportanceSourceSettings {
  keepLonger: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Bảng §5.3:
 *  - source `keep_longer` -> `keep` (luôn, kể cả mẫu từ chối — cờ user thắng gợi ý của hub);
 *  - mẫu REJECTED -> `junk`;
 *  - có delivery `DEAD`, hoặc vừa replay trong 24h -> `high`;
 *  - còn delivery đang chạy (PENDING/DELIVERING/RETRYING) -> `high` (đằng nào cũng không bao giờ dọn, §5.2 — xếp Cao để
 *    không ai gợi ý dọn nó);
 *  - không có delivery push nào -> `medium` (có thể có client polling, hub không biết cursor của họ);
 *  - mọi delivery `SUCCEEDED` -> `low`.
 */
export function importanceOf(
  event: ImportanceRecord,
  deliveries: readonly ImportanceDelivery[],
  sourceSettings: ImportanceSourceSettings,
  now: number = Date.now(),
): Importance {
  if (sourceSettings.keepLonger) return 'keep';
  if (event.kind === 'rejected_sample') return 'junk';
  if (event.lastReplayAt && now - event.lastReplayAt.getTime() < DAY_MS) return 'high';
  if (deliveries.length === 0) return 'medium';
  if (deliveries.every((d) => d.status === 'SUCCEEDED')) return 'low';
  return 'high';
}
