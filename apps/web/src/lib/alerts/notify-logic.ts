/**
 * CB4 (SPEC-canh-bao-nhan-dinh §8.1–8.3, CB:T15): quyết định CHUÔNG / BANNER / TOAST — hàm thuần, không React, để jest
 * test thẳng. Component chỉ gọi các hàm này rồi vẽ.
 *
 * Nguồn tin:
 *  - Socket `alert.changed` (chỉ operator, chỉ project đang mở — room `project:<id>:ops`): không có facts -> chỉ GHI NHẬN
 *    id (`noteSocketNotice`) rồi gọi lại API.
 *  - Danh sách OPEN xuyên project (`GET /alerts?state=OPEN`, poll 30s + gọi lại khi có `alert.changed`): lần tải ĐẦU là
 *    MỐC (không báo gì — cảnh báo cũ lúc tải trang không bật banner/toast); các lần sau, id CHƯA từng thấy = vừa đến.
 *
 * Định tuyến một cảnh báo vừa đến (`routeArrival`):
 *  - critical + đã nhận `alert.changed` của nó trong phiên này -> BANNER (project đang mở).
 *  - critical chỉ thấy qua poll (project khác — socket không mang tin project khác) -> TOAST dính (không tự đóng).
 *  - warning -> TOAST tự đóng sau 6s.  · info -> chỉ chuông.  · đã được ai đó "Đã xem" -> không báo.
 *  - RESOLVED không bao giờ toast; banner đang hiện đổi sang xanh 4s rồi thu lại.
 */
import type { AlertChangedNotice, AlertSeverity, AlertSummary, AlertView } from "./types";

// ------------------------------------------------------------------ chuông

export interface BellBadge {
  /** Số hiển thị ("99+" khi quá lớn). */
  label: string;
  count: number;
  tone: "critical" | "warning";
}

/**
 * Badge = số cảnh báo OPEN chưa xem; màu theo mức cao nhất CHƯA XEM (review L1: critical đã "Đã xem" không còn tô đỏ).
 * 0 -> không badge.
 */
export function bellBadge(summary: AlertSummary | null | undefined): BellBadge | null {
  const n = summary?.unacked ?? 0;
  if (n <= 0 || !summary) return null;
  const critical = (summary.unackedBySeverity ?? summary.openBySeverity).critical;
  return { count: n, label: n > 99 ? "99+" : String(n), tone: critical > 0 ? "critical" : "warning" };
}

/**
 * "Đánh dấu đã xem tất cả" gửi ĐÚNG id các cảnh báo CHƯA XEM đang hiện trong chuông (re-review CB4 — không theo mốc
 * thời gian: `opened_at` là `now` của lượt đánh giá, một cảnh báo commit muộn hơn cùng lượt có cùng mốc mà chưa ai thấy).
 * Rỗng -> nút tắt.
 */
export function ackAllIds(groups: readonly Pick<BellGroup, "items">[]): string[] {
  return groups.flatMap((g) => g.items.filter((a) => a.state === "OPEN" && !a.acknowledgedAt).map((a) => a.id));
}

const RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** critical trước, rồi mới nhất trước; cùng mốc thì theo id cho ổn định. */
export function compareForBell(a: AlertView, b: AlertView): number {
  return RANK[a.severity] - RANK[b.severity] || Date.parse(b.openedAt) - Date.parse(a.openedAt) || (a.id < b.id ? -1 : 1);
}

export interface BellGroup {
  project: AlertView["project"];
  /** Tổng OPEN của project (từ summary nếu có — danh sách có thể bị cắt). */
  count: number;
  critical: number;
  items: AlertView[];
  /** Số cảnh báo của project không hiện trong popover. */
  more: number;
}

/**
 * Nhóm cho popover: theo project; trong nhóm critical trước rồi mới nhất. Nhóm có critical lên trước (nhiều hơn trước),
 * rồi nhóm có cảnh báo mới nhất. Mỗi nhóm hiện tối đa `perGroup` dòng.
 */
export function groupForBell(rows: AlertView[], summary?: AlertSummary | null, perGroup = 5): BellGroup[] {
  const by = new Map<string, AlertView[]>();
  for (const r of rows) {
    if (r.state !== "OPEN") continue;
    const list = by.get(r.project.id) ?? [];
    list.push(r);
    by.set(r.project.id, list);
  }
  const groups = [...by.values()].map((items) => {
    items.sort(compareForBell);
    const s = summary?.perProject.find((p) => p.project.id === items[0].project.id);
    const count = s ? Math.max(s.critical + s.warning + s.info, items.length) : items.length;
    const critical = s ? s.critical : items.filter((i) => i.severity === "critical").length;
    const shown = items.slice(0, perGroup);
    return { project: items[0].project, count, critical, items: shown, more: count - shown.length };
  });
  const newest = (g: BellGroup) => Math.max(...g.items.map((i) => Date.parse(i.openedAt)));
  return groups.sort((a, b) => b.critical - a.critical || newest(b) - newest(a));
}

// ------------------------------------------------------------------ cảnh báo vừa đến (mốc phiên)

export interface FeedMemory {
  /** Đã có lần tải đầu (mốc) chưa. */
  primed: boolean;
  /** Mọi id OPEN đã thấy trong phiên — không báo lại lần hai. */
  seen: Set<string>;
  /** id nhận qua `alert.changed` (state OPEN) trong phiên — chỉ những cảnh báo này được bật banner. */
  socketOpened: Set<string>;
  /**
   * Mốc (ms, ĐỒNG HỒ SERVER — ADR-188). Review L3: cảnh báo mở TRƯỚC mốc mà lần đầu không thấy (danh sách bị cắt) không
   * phải "vừa đến". -∞ khi lần đầu đầy đủ.
   */
  baselineAt: number;
  /** id đang có toast — review L4: rời danh sách OPEN đầy đủ hoặc được "Đã xem" thì gỡ toast (toast dính không treo mãi). */
  toasted: Set<string>;
}

export function createFeedMemory(): FeedMemory {
  return { primed: false, seen: new Set(), socketOpened: new Set(), baselineAt: 0, toasted: new Set() };
}

/** Ghi nhận tin socket. OPEN -> nhớ id (để banner); trả về true = cần gọi lại API (luôn đúng — tin không có facts). */
export function noteSocketNotice(mem: FeedMemory, n: Pick<AlertChangedNotice, "id" | "state">): true {
  if (n.state === "OPEN") mem.socketOpened.add(n.id);
  return true;
}

/** Thông tin trang danh sách đi kèm (ADR-188): mốc ĐỒNG HỒ SERVER + danh sách có bị cắt không. */
export interface FeedMeta {
  /** `asOf` của `GET /alerts` — đồng hồ DB lúc đọc. Vắng (server cũ) -> rơi về max(openedAt) đã thấy. */
  asOf?: string | null;
  /** `next === null`: danh sách OPEN đầy đủ, không bị cắt. */
  complete?: boolean;
}

/**
 * Mốc "mới" của lần tải đầu — CHỈ từ dữ liệu server, không bao giờ `Date.now()` của trình duyệt (ADR-188: máy người
 * dùng lệch giờ làm nuốt toast mới hoặc bật lại cảnh báo cũ). Lần đầu ĐẦY ĐỦ -> không cần mốc (-∞): mọi OPEN đã thấy hết,
 * id lạ về sau chắc chắn mới — kể cả khi `opened_at` (đầu lượt evaluator) sớm hơn `asOf` vì lượt commit muộn. Bị cắt ->
 * `asOf` (đồng hồ DB), vắng thì max(openedAt) của trang (đồng hồ server ghi `opened_at`).
 */
function serverBaseline(rows: readonly AlertView[], meta: FeedMeta): number {
  if (meta.complete) return Number.NEGATIVE_INFINITY;
  const asOf = meta.asOf ? Date.parse(meta.asOf) : Number.NaN;
  if (Number.isFinite(asOf)) return asOf;
  const opened = rows.map((r) => Date.parse(r.openedAt)).filter(Number.isFinite);
  return opened.length ? Math.max(...opened) : Number.NEGATIVE_INFINITY;
}

/**
 * Cảnh báo vừa đến kể từ lần trước. Lần đầu (mốc): nhớ hết, trả [] — KHÔNG banner/toast cho cảnh báo cũ lúc tải trang
 * (CB:T15). Sau đó: dòng OPEN chưa thấy, chưa được ai "Đã xem". Mốc thời gian chỉ chặn id lạ mở TRƯỚC lần tải đầu bị
 * cắt (L3) và giữ CỐ ĐỊNH: các lần sau đã có tập `seen` (cùng nguồn server) — dời mốc theo asOf mới chỉ thêm rủi ro nuốt
 * cảnh báo commit muộn trong một lượt.
 */
export function takeArrivals(mem: FeedMemory, rows: readonly AlertView[], meta: FeedMeta = {}): AlertView[] {
  const open = rows.filter((r) => r.state === "OPEN");
  if (!mem.primed) {
    for (const r of open) mem.seen.add(r.id);
    mem.primed = true;
    mem.baselineAt = serverBaseline(open, meta);
    return [];
  }
  // Review L3: mở trước mốc mà chưa từng thấy (lần đầu bị cắt ở 100 dòng) = cảnh báo CŨ — trừ khi có alert.changed của nó.
  const fresh = open.filter(
    (r) => !mem.seen.has(r.id) && !r.acknowledgedAt && (mem.socketOpened.has(r.id) || Date.parse(r.openedAt) >= mem.baselineAt),
  );
  for (const r of open) mem.seen.add(r.id);
  if (meta.complete) pruneToOpen(mem, open);
  return fresh;
}

/**
 * Review R3 L2: `seen`/`socketOpened` không phình theo thời gian mở tab. Chỉ cắt khi danh sách OPEN ĐẦY ĐỦ: id vắng mặt
 * lúc đó đã đóng, và id đã đóng không bao giờ OPEN lại (mỗi episode một uuid mới — `ON CONFLICT … WHERE state='OPEN'`),
 * nên quên nó không gây toast lại. `socketOpened` giữ id CHƯA từng thấy trong danh sách: tin socket có thể tới trước khi
 * lượt poll đang bay thấy dòng đó — xoá sớm thì critical của chính phiên rơi từ banner sang toast. (Id socket báo OPEN
 * rồi đóng trước mọi lượt poll thì còn lại — số ít, chấp nhận.) Danh sách bị cắt: không cắt gì (giữ L3).
 */
function pruneToOpen(mem: FeedMemory, open: readonly AlertView[]): void {
  const openIds = new Set(open.map((r) => r.id));
  for (const id of mem.socketOpened) if (!openIds.has(id) && mem.seen.has(id)) mem.socketOpened.delete(id);
  for (const id of mem.seen) if (!openIds.has(id)) mem.seen.delete(id);
}

export const WARNING_TOAST_MS = 6_000;

export type ArrivalRoute = { kind: "banner" } | { kind: "toast"; durationMs: number } | { kind: "none" };

export function routeArrival(a: Pick<AlertView, "id" | "severity" | "state" | "acknowledgedAt">, mem: Pick<FeedMemory, "socketOpened">): ArrivalRoute {
  if (a.state !== "OPEN" || a.acknowledgedAt) return { kind: "none" };
  if (a.severity === "critical") {
    return mem.socketOpened.has(a.id) ? { kind: "banner" } : { kind: "toast", durationMs: Number.POSITIVE_INFINITY };
  }
  if (a.severity === "warning") return { kind: "toast", durationMs: WARNING_TOAST_MS };
  return { kind: "none" };
}

/** Chờ tên đối tượng tối đa bấy nhiêu trước khi hiện toast (quá hạn -> "Đích 1cc4de59"). */
export const TOAST_NAME_TIMEOUT_MS = 1_500;

export type NameLookup = (subjectId: string) => string | null;

/**
 * Tên đích/nguồn cho toast TRƯỚC khi hiện (xem trên trình duyệt thật: toast của project khác ra "Đích 1cc4de59" vì câu
 * dựng lúc cảnh báo đến, trước khi tên của project đó tải xong). Đã biết -> trả ngay; cấp dự án -> null (nhãn "Toàn dự
 * án"); chưa biết -> `load()` tên của project đó, chờ tối đa `timeoutMs`; lỗi/quá hạn -> null (nhãn rơi về id ngắn).
 */
export async function resolveSubjectName(
  a: Pick<AlertView, "subjectType" | "subjectId">,
  known: NameLookup,
  load: () => Promise<NameLookup>,
  timeoutMs = TOAST_NAME_TIMEOUT_MS,
): Promise<string | null> {
  if (a.subjectType === "project") return null;
  const hit = known(a.subjectId);
  if (hit) return hit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), timeoutMs);
  });
  try {
    const lookup = await Promise.race([load(), timeout]);
    return lookup ? lookup(a.subjectId) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Review L4: toast nào phải gỡ — cảnh báo đã được "Đã xem", hoặc vắng khỏi danh sách OPEN ĐẦY ĐỦ (đã đóng). Danh sách
 * bị cắt thì chỉ gỡ theo "Đã xem". Trả id và quên chúng khỏi `mem.toasted`.
 */
export function toastsToDismiss(mem: Pick<FeedMemory, "toasted">, rows: readonly AlertView[], complete: boolean): string[] {
  const byId = new Map(rows.filter((r) => r.state === "OPEN").map((r) => [r.id, r]));
  const out: string[] = [];
  for (const id of mem.toasted) {
    const row = byId.get(id);
    if (row ? row.acknowledgedAt : complete) out.push(id);
  }
  for (const id of out) mem.toasted.delete(id);
  return out;
}

// ------------------------------------------------------------------ banner

export const BANNER_RESOLVED_HOLD_MS = 4_000;
export const BANNER_ANIMATION_MS = 200;

export interface BannerEntry {
  alert: AlertView;
  phase: "open" | "resolved";
  resolvedAt?: number;
}

/** Mới nhất ở đầu. Chỉ chứa critical nhận qua `alert.changed` trong phiên. */
export interface BannerState {
  entries: BannerEntry[];
}

export const emptyBanner = (): BannerState => ({ entries: [] });

export function bannerAdd(s: BannerState, alert: AlertView): BannerState {
  if (s.entries.some((e) => e.alert.id === alert.id)) return s;
  return { entries: [{ alert, phase: "open" }, ...s.entries] };
}

/** RESOLVED: banner ĐANG HIỆN đổi xanh (giữ `BANNER_RESOLVED_HOLD_MS`); cảnh báo đang nằm trong "+k" thì bỏ luôn. */
export function bannerResolve(s: BannerState, id: string, now: number): BannerState {
  const i = s.entries.findIndex((e) => e.alert.id === id);
  if (i < 0) return s;
  if (i > 0) return { entries: s.entries.filter((_, j) => j !== i) };
  if (s.entries[0].phase === "resolved") return s;
  return { entries: [{ ...s.entries[0], phase: "resolved", resolvedAt: now }, ...s.entries.slice(1)] };
}

/** "Đã xem" (ack) -> bỏ khỏi banner ngay (cảnh báo vẫn OPEN trong chuông). */
export function bannerAck(s: BannerState, id: string): BannerState {
  return s.entries.some((e) => e.alert.id === id) ? { entries: s.entries.filter((e) => e.alert.id !== id) } : s;
}

/**
 * Review TB2: hạn sớm nhất của các banner xanh còn chờ thu (ms) — hẹn giờ theo MỐC này và hẹn lại sau mỗi lần thu, để
 * banner xanh thứ hai (A đóng -> C đến rồi đóng) không bị bỏ quên. Không có -> null.
 */
export function bannerNextExpiry(s: BannerState, holdMs = BANNER_RESOLVED_HOLD_MS): number | null {
  let next: number | null = null;
  for (const e of s.entries) {
    if (e.phase !== "resolved") continue;
    const at = (e.resolvedAt ?? 0) + holdMs;
    if (next === null || at < next) next = at;
  }
  return next;
}

/** Review TB3: khoá thông báo cho trình đọc màn hình — đổi đúng MỘT lần khi cảnh báo mới hiện hoặc khi nó đã ổn. */
export function bannerAnnounceKey(e: BannerEntry | null): string | null {
  return e ? `${e.alert.id}:${e.phase}` : null;
}

/** Bỏ banner xanh đã giữ đủ 4s. */
export function bannerExpire(s: BannerState, now: number, holdMs = BANNER_RESOLVED_HOLD_MS): BannerState {
  const keep = s.entries.filter((e) => e.phase !== "resolved" || now - (e.resolvedAt ?? now) < holdMs);
  return keep.length === s.entries.length ? s : { entries: keep };
}

/**
 * Đối chiếu với danh sách OPEN mới nhất (banner sống qua chuyển trang/đổi project — socket không còn mang tin của
 * project cũ): đã có người "Đã xem" -> bỏ; còn OPEN -> cập nhật số liệu (khi `lastSeenAt` đổi); vắng mặt và danh sách ĐẦY ĐỦ (không bị cắt)
 * -> coi như RESOLVED. Danh sách bị cắt thì không suy luận gì từ sự vắng mặt.
 */
export function bannerSync(s: BannerState, openRows: readonly AlertView[], complete: boolean, now: number): BannerState {
  let next = s;
  for (const e of s.entries) {
    if (e.phase !== "open") continue;
    const row = openRows.find((r) => r.id === e.alert.id);
    if (!row) {
      if (complete) next = bannerResolve(next, e.alert.id, now);
    } else if (row.acknowledgedAt) {
      next = bannerAck(next, e.alert.id);
    } else if (row.lastSeenAt !== e.alert.lastSeenAt) {
      // Số liệu mới đi kèm `last_seen_at` mới (upsert ghi cả hai) — so mốc này để poll không tạo state mới khi không đổi gì.
      next = { entries: next.entries.map((x) => (x.alert.id === row.id ? { ...x, alert: row } : x)) };
    }
  }
  return next;
}

/** Nhiều critical -> MỘT banner (mới nhất) + "+k cảnh báo nghiêm trọng khác" (k = số còn mở, không tính cái đang hiện). */
export function selectBanner(s: BannerState): { primary: BannerEntry | null; more: number } {
  const primary = s.entries[0] ?? null;
  return { primary, more: s.entries.slice(1).filter((e) => e.phase === "open").length };
}

/** Chuyển động: trượt xuống 200ms + mờ dần; `prefers-reduced-motion` -> CHỈ mờ dần, không trượt (keyframes ở styles/alerts.css). */
export function bannerMotion(reducedMotion: boolean): { enter: string; exit: string; durationMs: number } {
  return reducedMotion
    ? { enter: "alert-fade-in", exit: "alert-fade-out", durationMs: BANNER_ANIMATION_MS }
    : { enter: "alert-slide-in", exit: "alert-slide-out", durationMs: BANNER_ANIMATION_MS };
}
