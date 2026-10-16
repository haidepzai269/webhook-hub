/**
 * ADR-238 — "cổng" của hubFetch trong lúc AuthGuard còn chờ `/auth/me`.
 *
 * Guard KHÔNG còn ẩn cả cây (trang trắng 10–60s khi Render free ngủ): khung app + trang thật render ngay, query của trang
 * khởi động bình thường (isLoading -> khung chờ đúng bố cục) nhưng REQUEST bị giữ ở đây tới khi phiên được xác nhận và
 * project đã chọn — nên không có dữ liệu bảo vệ nào hiện ra trước khi auth xong, và không request nào thiếu `?projectId=`.
 *
 * Cổng chỉ đóng khi có guard đang gắn (mặc định MỞ — trang login/invite… không bị kẹt). `/auth/*` không bao giờ bị giữ
 * (chính guard + refresh đi qua đó). TS thuần, không React — jest gốc import thẳng.
 */

let gate: { promise: Promise<void>; open: () => void } | null = null;
let holders = 0;

export function isAuthGateClosed(): boolean {
  return gate !== null;
}

/** Đóng cổng (idempotent): request mới phải chờ `openAuthGate()`. */
export function closeAuthGate(): void {
  if (gate) return;
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  gate = { promise, open };
}

/** Mở cổng: mọi request đang chờ đi tiếp (và tự gắn project đã chọn lúc ĐI, không phải lúc gọi). */
export function openAuthGate(): void {
  const g = gate;
  gate = null;
  g?.open();
}

/** Chờ tới khi cổng mở. Vòng lặp: mở rồi đóng lại ngay (guard mới gắn) thì chờ tiếp. */
export async function waitForAuthGate(): Promise<void> {
  while (gate) await gate.promise;
}

/**
 * Guard gắn vào cây -> giữ cổng. Gỡ guard -> nhả SAU một nhịp: React StrictMode / chuyển layout gỡ rồi gắn lại ngay trong
 * cùng commit — không được mở cổng giữa chừng (request lọt ra trước auth, thiếu projectId).
 */
export function holdAuthGate(): void {
  holders++;
  closeAuthGate();
}

export function releaseAuthGate(): void {
  holders = Math.max(0, holders - 1);
  setTimeout(() => {
    if (holders === 0) openAuthGate();
  }, 0);
}

/** Chỉ cho test. */
export function resetAuthGateForTest(): void {
  holders = 0;
  openAuthGate();
}
