/**
 * ADR-269 — badge "chưa xem" của sidebar dự án (events / deliveries / dlq; Flow map KHÔNG có). TS thuần để jest test thẳng.
 * Mốc last-seen ở localStorage theo (user, project, tab); đếm kẹp ở `BADGE_CAP`; chỉ giữ MỘT bản ghi mới nhất để dựng tooltip.
 */
export const BADGE_CAP = 10;
export const BADGE_TABS = ["events", "deliveries", "dlq"] as const;
export type BadgeTab = (typeof BADGE_TABS)[number];

export interface LatestEvent {
  type: string;
  source: string;
  at: string;
}
export interface LatestDelivery {
  destination: string;
  status: string;
  at: string;
}
export interface LatestDead {
  destination: string;
  attemptNo: number;
  at: string;
}
export interface BadgeLatest {
  events: LatestEvent | null;
  deliveries: LatestDelivery | null;
  dlq: LatestDead | null;
}
export interface BadgeState {
  counts: Record<BadgeTab, number>;
  latest: BadgeLatest;
}

/** Khớp phản hồi `GET /api/v1/badges`. */
export interface BadgesResponse {
  events: { count: number; latest: LatestEvent | null; cursor: string | null };
  deliveries: { count: number; latest: LatestDelivery | null; cursor: string | null };
  dlq: { count: number; latest: LatestDead | null; cursor: string | null };
}

export const emptyBadges = (): BadgeState => ({
  counts: { events: 0, deliveries: 0, dlq: 0 },
  latest: { events: null, deliveries: null, dlq: null },
});

/** 0 -> ẩn (null); 1..9 -> số; từ 10 -> "9+". */
export function formatBadge(n: number): string | null {
  if (!(n > 0)) return null;
  return n > 9 ? "9+" : String(Math.floor(n));
}

/** Tab của sidebar ứng với đường đang mở (null = không phải tab có badge). */
export function badgeTabOfPath(pathname: string): BadgeTab | null {
  for (const t of BADGE_TABS) {
    const base = `/dashboard/${t}`;
    if (pathname === base || pathname.startsWith(`${base}/`)) return t;
  }
  return null;
}

/** Khoá localStorage: `hub:seen:<userId>:<projectId>:<tab>` (theo mẫu project-store.ts). */
export const seenKey = (userId: string, projectId: string, tab: BadgeTab) => `hub:seen:${userId}:${projectId}:${tab}`;
export const SEEN_PREFIX = "hub:seen:";

/**
 * Cộng dồn từ socket: đang đứng ở chính tab đó thì KHÔNG tăng (người dùng đang nhìn thấy nó). Kẹp ở BADGE_CAP.
 * `latest` được ghi đè bằng bản ghi mới nhất của lô.
 */
export function addLive<T extends BadgeTab>(
  s: BadgeState,
  tab: T,
  n: number,
  latest: BadgeLatest[T],
  currentTab: BadgeTab | null,
): BadgeState {
  if (tab === currentTab || n <= 0) return s;
  return {
    counts: { ...s.counts, [tab]: Math.min(BADGE_CAP, s.counts[tab] + n) },
    latest: { ...s.latest, [tab]: latest },
  };
}

/** Nhận kết quả server (nguồn sự thật): ghi đè đếm; tab đang mở luôn 0. */
export function applyServer(s: BadgeState, r: BadgesResponse, currentTab: BadgeTab | null): BadgeState {
  const next = emptyBadges();
  for (const t of BADGE_TABS) {
    const open = t === currentTab;
    next.counts[t] = open ? 0 : Math.min(BADGE_CAP, r[t].count);
    (next.latest as Record<BadgeTab, unknown>)[t] = open || r[t].count === 0 ? null : (r[t].latest ?? s.latest[t]);
  }
  return next;
}

/** Đã xem tab: đếm về 0, bỏ latest. (Mốc mới do store ghi từ `cursor` của server.) */
export function markSeen(s: BadgeState, tab: BadgeTab): BadgeState {
  return {
    counts: { ...s.counts, [tab]: 0 },
    latest: { ...s.latest, [tab]: null },
  };
}

/** Đổi project / đổi user: bỏ sạch đếm (mốc của project mới đọc lại từ localStorage). */
export function resetBadges(): BadgeState {
  return emptyBadges();
}

/** Tên đích theo id cho tooltip live — bản đồ nhỏ, bỏ cái cũ nhất khi vượt `max` (không phình theo thời gian). */
export function rememberName(map: Map<string, string>, id: string, name: string, max = 200): void {
  map.delete(id);
  map.set(id, name);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}
