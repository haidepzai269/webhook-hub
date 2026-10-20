import { type BadgeTab, SEEN_PREFIX, seenKey } from "./badges-logic";

/**
 * ADR-269: mốc last-seen của badge sidebar trong localStorage (theo mẫu project-store.ts — try/catch, chỉ là tiện ích:
 * mất mốc thì tab đó coi như "chưa từng xem" và lấy lại mốc hiện tại của server, không bao giờ làm sai dữ liệu).
 * Tách file riêng (không import hubFetch) để `client.logout` xoá được mà không vòng import.
 */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Sau `clearSeenMarks` (đăng xuất) mọi `writeSeen` bị từ chối tới khi `armSeenWrites` — request /badges về muộn không được ghi lại mốc. */
let cleared = false;
export function armSeenWrites(): void {
  cleared = false;
}

export function readSeen(userId: string, projectId: string, tab: BadgeTab): string | null {
  try {
    return storage()?.getItem(seenKey(userId, projectId, tab)) ?? null;
  } catch {
    return null;
  }
}

export function writeSeen(userId: string, projectId: string, tab: BadgeTab, value: string): void {
  if (cleared) return;
  try {
    storage()?.setItem(seenKey(userId, projectId, tab), value);
  } catch {
    /* chỉ không nhớ */
  }
}

/** Đăng xuất: xoá mọi mốc `hub:seen:*` — user sau trên cùng trình duyệt không thừa hưởng. */
export function clearSeenMarks(): void {
  cleared = true;
  try {
    const s = storage();
    if (!s) return;
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(SEEN_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    /* bỏ qua */
  }
}
