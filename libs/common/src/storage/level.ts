/**
 * QT (SPEC-han-muc-dung-luong §3 + ĐÍNH CHÍNH E1, ADR-182/189): nấc dung lượng của một project và quyết định chặn chiều ghi.
 * Hàm THUẦN — không I/O, không đọc env (người gọi truyền cờ đã đọc lúc khởi động). Dùng chung cho hub-api (/hooks, publish)
 * và hub-worker (job cập nhật nấc). Không xét provider (không `if (provider === …)`).
 */
export const STORAGE_LEVELS = ['OK', 'WARN_70', 'WARN_85', 'CRITICAL_95', 'LOCKED', 'HARD_LOCKED'] as const;
export type StorageLevel = (typeof STORAGE_LEVELS)[number];

/** E1: phần dôi cho source "Giữ lâu" — HẰNG SỐ, không phải env (bớt một núm vặn). Hạn mức user thấy vẫn là 100%. */
export const HARD_LIMIT_PCT = 110;

/** Ngưỡng VÀO của từng nấc (% hạn mức). */
const ENTER_PCT: Record<StorageLevel, number> = { OK: 0, WARN_70: 70, WARN_85: 85, CRITICAL_95: 95, LOCKED: 100, HARD_LOCKED: HARD_LIMIT_PCT };
/**
 * Ngưỡng RỜI (vùng đệm): cảnh báo hạ khi thấp hơn ngưỡng 5 điểm; `LOCKED` chỉ mở khi < 90%; `HARD_LOCKED` về `LOCKED`
 * khi < 100% (rồi theo vùng đệm của `LOCKED`). Không có vùng đệm thì cleanup + traffic làm trạng thái bật tắt liên tục.
 */
const LEAVE_PCT: Record<StorageLevel, number> = { OK: 0, WARN_70: 65, WARN_85: 80, CRITICAL_95: 90, LOCKED: 90, HARD_LOCKED: 100 };

const rank = (l: StorageLevel) => STORAGE_LEVELS.indexOf(l);

/** Giá trị đọc từ DB (varchar) -> nấc; lạ / null -> `OK` (fail-open, §4). */
export function parseStorageLevel(v: unknown): StorageLevel {
  return typeof v === 'string' && (STORAGE_LEVELS as readonly string[]).includes(v) ? (v as StorageLevel) : 'OK';
}

/**
 * Nấc theo mức dùng, có vùng đệm theo nấc trước. Đi LÊN thì lên thẳng nấc cao nhất đã vượt; đi XUỐNG thì hạ từng nấc chừng
 * nào mức dùng còn thấp hơn ngưỡng rời của nấc đang đứng. `quota` ≤ 0 / số hỏng -> `OK` (hạn mức là chống lạm dụng, không
 * phải bất biến đúng–sai: lỗi cấu hình không được khoá project).
 */
export function levelFor(used: number, quota: number, prevLevel?: StorageLevel | string | null): StorageLevel {
  if (!Number.isFinite(used) || !Number.isFinite(quota) || quota <= 0) return 'OK';
  const pct = (Math.max(0, used) / quota) * 100;
  let raw: StorageLevel = 'OK';
  for (const l of STORAGE_LEVELS) if (pct >= ENTER_PCT[l]) raw = l;
  let level = parseStorageLevel(prevLevel);
  if (rank(raw) >= rank(level)) return raw;
  while (rank(level) > rank(raw) && pct < LEAVE_PCT[level]) level = STORAGE_LEVELS[rank(level) - 1];
  return level;
}

/**
 * E1: quyết định chặn chiều ghi — DÙNG CHUNG cho `/hooks` và publish. `LOCKED` chặn source thường, source "Giữ lâu" (cờ
 * user TỰ gắn, hub không đoán — BB-1) còn nhận tới `HARD_LOCKED` (110%). `lockEnabled` = `STORAGE_LOCK_ENABLED` (E5).
 */
export function isWriteBlocked(level: StorageLevel, keepLonger: boolean, lockEnabled: boolean): boolean {
  return lockEnabled && (level === 'HARD_LOCKED' || (level === 'LOCKED' && !keepLonger));
}

/** E5: `STORAGE_LOCK_ENABLED` — mặc định 0 (production chưa khoá thật tới khi Admin bật). Chỉ "1"/"true" là bật. */
export function resolveStorageLockEnabled(v: string | undefined = process.env.STORAGE_LOCK_ENABLED): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

/** §2: hạn mức mặc định `PROJECT_STORAGE_QUOTA_MB` (mặc định 50). Giá trị hỏng -> 50. */
export const DEFAULT_PROJECT_STORAGE_QUOTA_MB = 50;
export function resolveProjectStorageQuotaMb(v: string | undefined = process.env.PROJECT_STORAGE_QUOTA_MB): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_PROJECT_STORAGE_QUOTA_MB;
}

/** Hạn mức (byte) của một project: `projects.storage_quota_mb` (operator ghi đè) nếu > 0, không thì mặc định. */
export function quotaBytesFor(projectQuotaMb: number | null | undefined, defaultMb: number = resolveProjectStorageQuotaMb()): number {
  const mb = typeof projectQuotaMb === 'number' && Number.isFinite(projectQuotaMb) && projectQuotaMb > 0 ? projectQuotaMb : defaultMb;
  return Math.round(mb * 1024 * 1024);
}
