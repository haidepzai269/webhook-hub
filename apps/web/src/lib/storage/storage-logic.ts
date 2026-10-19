/**
 * QT7 (SPEC-han-muc-dung-luong §3, §5, §9 + ĐÍNH CHÍNH E1/E5): logic THUẦN của trang Dung lượng + banner theo nấc — TS thuần
 * (không React, không alias `@/`) để jest gốc test thẳng. Câu chữ dịch ở page-storage.ts; ở đây chỉ chọn KHOÁ + biến.
 */
import type { MessageKey } from "../i18n/dictionary";

export const STORAGE_LEVELS = ["OK", "WARN_70", "WARN_85", "CRITICAL_95", "LOCKED", "HARD_LOCKED"] as const;
export type StorageLevel = (typeof STORAGE_LEVELS)[number];
export type Importance = "junk" | "low" | "medium" | "high" | "keep";
export const IMPORTANCES: Importance[] = ["junk", "low", "medium", "high", "keep"];

export interface StorageSuggestion {
  id: string;
  action: "trim" | "delete";
  importance: Importance[];
  olderThan: string;
  sourceId: string | null;
  estimatedBytes: number;
  estimatedEvents: number;
  reason: string;
  reasonCode: string;
  advisor: string;
  expiresAt: string;
}

export interface CleanJobView {
  id: string;
  action: "trim" | "delete";
  importance: string[];
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  freedBytes: number;
  events: number;
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /api/v1/projects/:p/storage`. */
export interface StorageOverview {
  estimated: true;
  usedBytes: number;
  quotaBytes: number;
  usedPct: number;
  level: StorageLevel;
  measuredAt: string | null;
  calibratedAt: string | null;
  bloatFactor: number;
  bySource: { sourceId: string; name: string | null; keepLonger: boolean; bytes: number }[];
  byImportance: Record<Importance, { events: number; bytes: number }>;
  growthPerDay: number;
  forecastHours: number | null;
  suggestions: StorageSuggestion[];
  suggestionsAt: string | null;
  lockEnabled: boolean;
  autoCleanEnabled: boolean;
  recentCleanJobs: CleanJobView[];
  sources?: { count: number; limit: number };
}

export interface StoragePolicyView {
  importance: "junk" | "low" | "medium";
  action: "trim" | "delete" | "off";
  afterDays: number;
  trigger: "always" | "above_85";
  updatedBy: string;
  updatedAt: string | null;
}

export interface StoragePolicies {
  policies: StoragePolicyView[];
  autoCleanEnabled: boolean;
  status: "running" | "installed_not_running";
  message: string;
  lastRun: { at: string; importance: string; events: number; freedBytes: number } | null;
}

/** Byte -> "12.3 MB" (cùng cách viết với câu cảnh báo/email — `formatBytes` của libs/common/alerts/text). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function parseLevel(v: unknown): StorageLevel {
  return (STORAGE_LEVELS as readonly string[]).includes(v as string) ? (v as StorageLevel) : "OK";
}

export type Tone = "ok" | "warning" | "danger";

/** Đoạn khoá i18n của nấc: `WARN_70` -> `warn-70` (khoá chỉ chữ thường, '.', '-'). */
export function levelSeg(level: string): string {
  return level.toLowerCase().replace(/_/g, "-");
}

/** Màu theo nấc: < 70 xanh, 70/85 hổ phách, 95+ đỏ. */
export function levelTone(level: StorageLevel): Tone {
  if (level === "OK") return "ok";
  if (level === "WARN_70" || level === "WARN_85") return "warning";
  return "danger";
}

export interface StorageBanner {
  tone: "warning" | "danger";
  messageKey: MessageKey;
  /** Câu thêm khi cờ khoá TẮT ở nấc khoá (E5: nói thật "Khoá chưa bật…, sự kiện vẫn được nhận"). */
  extraKey: MessageKey | null;
  /** §3: 70% tắt được (ẩn trong phiên); 85% hiện + toast; 95%/LOCKED không tắt được. */
  dismissible: boolean;
  /** §9: LOCKED/HARD_LOCKED có HAI nút "Dọn theo gợi ý" + "Liên hệ người vận hành"; nấc khác một nút mở trang. */
  actions: ("open" | "clean" | "contact")[];
  /** §3: 85% -> toast mỗi lần mở console (một lần mỗi phiên). */
  toastOnOpen: boolean;
}

/** Banner theo nấc (§3, §9, E1, E5). OK -> null. Không bao giờ có nút "Nâng cấp" (chưa có gói trả phí). */
export function storageBannerFor(level: StorageLevel, lockEnabled: boolean): StorageBanner | null {
  switch (level) {
    case "OK":
      return null;
    case "WARN_70":
      return { tone: "warning", messageKey: "page.storage.banner.warn-70", extraKey: null, dismissible: true, actions: ["open"], toastOnOpen: false };
    case "WARN_85":
      return { tone: "warning", messageKey: "page.storage.banner.warn-85", extraKey: null, dismissible: true, actions: ["open"], toastOnOpen: true };
    case "CRITICAL_95":
      return { tone: "danger", messageKey: "page.storage.banner.critical-95", extraKey: null, dismissible: false, actions: ["clean"], toastOnOpen: false };
    case "LOCKED":
    case "HARD_LOCKED":
      return {
        tone: "danger",
        // Cờ khoá tắt: KHÔNG nói "đã ngừng nhận" (sai sự thật) — câu chính là "Khoá chưa bật…".
        messageKey: lockEnabled ? (level === "LOCKED" ? "page.storage.banner.locked" : "page.storage.banner.hard-locked") : "page.storage.banner.lock-off",
        extraKey: null,
        dismissible: false,
        actions: ["clean", "contact"],
        toastOnOpen: false,
      };
  }
}

/** "3d" -> { n: 3, unit: "d" } (đơn vị m/h/d của API) — để câu "cũ hơn 3 ngày" dịch được. */
export function parseAge(olderThan: string): { n: number; unit: "m" | "h" | "d" } | null {
  const m = /^(\d+)([mhd])$/.exec(olderThan ?? "");
  return m ? { n: Number(m[1]), unit: m[2] as "m" | "h" | "d" } : null;
}

/** Hộp xác nhận nói ĐÁNH ĐỔI (§5.1): Dọn giữ chống trùng; Xoá hẳn mất chống trùng; có mức Cao thì thêm câu riêng. */
export function confirmKeys(action: "trim" | "delete", importance: readonly string[]): { titleKey: MessageKey; bodyKeys: MessageKey[] } {
  const bodyKeys: MessageKey[] = [action === "trim" ? "page.storage.confirm.trim" : "page.storage.confirm.delete"];
  if (importance.includes("high")) bodyKeys.push("page.storage.confirm.high");
  return { titleKey: action === "trim" ? "page.storage.confirm.title.trim" : "page.storage.confirm.title.delete", bodyKeys };
}

/** Body của `POST …/storage/clean` cho một dòng gợi ý được bấm với hành động người dùng chọn (Dọn hoặc Xoá hẳn). */
export function cleanBodyFor(s: Pick<StorageSuggestion, "importance" | "olderThan" | "sourceId">, action: "trim" | "delete") {
  // "Rác" chỉ Xoá hẳn (mẫu bị từ chối không có "dòng gầy" để giữ) — bấm Dọn trên dòng Rác bị server 400; giao diện ẩn nút đó.
  return {
    action,
    importance: [...s.importance],
    olderThan: s.olderThan,
    ...(s.sourceId ? { sourceId: s.sourceId } : {}),
    ...(s.importance.includes("high") ? { confirmHigh: true } : {}),
  };
}

/** Nút có ý nghĩa cho một gợi ý: Rác chỉ có Xoá hẳn. */
export function suggestionActions(s: Pick<StorageSuggestion, "importance">): ("trim" | "delete")[] {
  return s.importance.length === 1 && s.importance[0] === "junk" ? ["delete"] : ["trim", "delete"];
}

/** Thanh mức dùng: phần trăm hiển thị kẹp 0–100 (vượt 100 vẫn ghi số thật ở nhãn). */
export function barPct(usedPct: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(usedPct) ? usedPct : 0));
}

/** Ô ghi đè hạn mức của operator: "" -> null (về mặc định), số nguyên 1–102400, sai -> undefined. */
export function parseQuotaInput(v: string): number | null | undefined {
  const s = v.trim();
  if (s === "") return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 102_400 ? n : undefined;
}

/** "N/20 nguồn" — null khi server cũ chưa trả. */
export function sourceCountVars(o: Pick<StorageOverview, "sources"> | undefined): { count: number; limit: number } | null {
  return o?.sources && Number.isFinite(o.sources.count) && Number.isFinite(o.sources.limit) ? o.sources : null;
}
