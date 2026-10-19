/**
 * ADR-262: logic thuần của "chọn khoảng trên biểu đồ Tổng quan" (kéo / bấm / bàn phím) — TS thuần, không React, không alias `@/`
 * để jest gốc test thẳng. Bucket do SERVER cắt theo giờ Việt Nam (GMT+7, KHÔNG có DST) nên mép bucket là hằng số:
 * giờ = chẵn giờ UTC; ngày = 17:00Z hôm trước. Mọi mốc ra ngoài là ISO UTC (cùng khuôn `from`/`to` của list-url).
 */

export type ChartRange = "24h" | "7d";

export const VN_OFFSET_MS = 7 * 3_600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Selection {
  from: string;
  to: string;
}

export const bucketMs = (range: ChartRange): number => (range === "24h" ? HOUR : DAY);

/** Đầu bucket chứa `ms` (24h: chẵn giờ; 7d: 00:00 giờ Việt Nam). */
export function floorBucket(ms: number, range: ChartRange): number {
  if (range === "24h") return Math.floor(ms / HOUR) * HOUR;
  return Math.floor((ms + VN_OFFSET_MS) / DAY) * DAY - VN_OFFSET_MS;
}

/**
 * Hai bucket (nhãn trục = chuỗi `bucket` ISO của server) -> khoảng chốt. Kéo ngược (phải sang trái) được chuẩn hoá;
 * cùng bucket (kéo < 1 bucket) = bấm = trọn bucket đó. "Đến" = hết bucket (…:59:59.999).
 */
export function selectionFromLabels(a: string, b: string, range: ChartRange): Selection | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  const lo = floorBucket(Math.min(ta, tb), range);
  const hi = floorBucket(Math.max(ta, tb), range);
  return { from: new Date(lo).toISOString(), to: new Date(hi + bucketMs(range) - 1).toISOString() };
}

/** Đọc `from`/`to` từ URL: đủ hai đầu, hợp lệ, `from` ≤ `to`; ngược lại coi như không chọn. */
export function parseSelection(from: string | undefined, to: string | undefined): Selection | null {
  if (!from || !to) return null;
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t) || f > t) return null;
  return { from, to };
}

/**
 * Vùng chọn -> hai nhãn trục (bucket đầu/cuối) để vẽ lớp phủ. Chỉ số kẹp vào trục đang vẽ; nằm hoàn toàn ngoài trục -> null.
 * Trả thêm chỉ số để vẽ phần mờ hai bên.
 */
export function overlayIndexes(buckets: readonly string[], sel: Selection | null): { i1: number; i2: number } | null {
  if (!sel || buckets.length === 0) return null;
  const ts = buckets.map((b) => Date.parse(b));
  const f = Date.parse(sel.from);
  const t = Date.parse(sel.to);
  const last = ts.length - 1;
  if (t < ts[0] || f > ts[last] + (ts[last] - ts[Math.max(0, last - 1)] || HOUR) - 1) return null;
  let i1 = ts.findIndex((x) => x >= f);
  if (i1 < 0) i1 = last;
  let i2 = last;
  for (let i = last; i >= 0; i--) {
    if (ts[i] <= t) {
      i2 = i;
      break;
    }
  }
  if (i1 > i2) i1 = i2;
  return { i1, i2 };
}

/** Mốc thời gian (vd `receivedAt` của dòng đang rê) -> nhãn bucket chứa nó, nếu nằm trên trục. */
export function bucketLabelFor(buckets: readonly string[], iso: string, range: ChartRange): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const start = floorBucket(ms, range);
  return buckets.find((b) => Date.parse(b) === start) ?? null;
}

/** Bàn phím: dịch con trỏ bucket `delta` bước (kẹp 0..n-1); chưa có con trỏ -> bắt đầu ở bucket cuối. */
export function moveIndex(current: number | null, delta: number, n: number): number {
  if (n <= 0) return 0;
  const base = current ?? n - 1;
  return Math.max(0, Math.min(n - 1, base + delta));
}

export interface KbState {
  anchor: number;
  focus: number;
}

/**
 * Bàn phím: bước tiếp theo của (anchor, focus). Không Shift: cả hai về bucket mới (chọn đúng một bucket). Có Shift: anchor
 * GIỮ NGUYÊN, chỉ focus dịch — Shift+← / Shift+→ nhờ vậy mở rộng và thu hẹp đúng. `prev` null = chưa có trạng thái
 * (bắt đầu từ bucket cuối); người gọi truyền {anchor:i1, focus:i2} của vùng chọn hiện có để tiếp tục từ đó.
 */
export function kbStep(prev: KbState | null, delta: number, shift: boolean, n: number): KbState {
  const base = prev ?? { anchor: Math.max(0, n - 1), focus: Math.max(0, n - 1) };
  const focus = moveIndex(base.focus, delta, n);
  return { anchor: shift ? Math.max(0, Math.min(n - 1, base.anchor)) : focus, focus };
}

/** "14-10 00:00" theo GMT+7 (tính tay, không phụ thuộc múi giờ máy). */
export function formatVn(iso: string): string {
  const d = new Date(Date.parse(iso) + VN_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const formatSelection = (s: Selection): string => `${formatVn(s.from)} → ${formatVn(s.to)}`;

/** Link "Xem tất cả" sang trang Sự kiện, mang đúng khoảng (list-url: ISO UTC, "đến" gồm …:59.999). */
export function eventsHref(s: Selection): string {
  const p = new URLSearchParams({ from: s.from, to: s.to });
  return `/dashboard/events?${p.toString()}`;
}
