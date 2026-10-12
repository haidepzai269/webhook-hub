/**
 * Hiệu ứng "cuộn giấy mở ra" (ADR-163) cho danh sách cuộn vô hạn: CHỈ dòng mới nạp / mới chèn mở ra; dòng đã có
 * trên màn hình KHÔNG BAO GIỜ chạy lại (điều sống còn với nhật ký trực tiếp — socket làm mới cả danh sách liên tục).
 *
 * Cách làm: số phận của một dòng (mở ra hay không, trễ bao nhiêu) quyết định ĐÚNG MỘT LẦN — lần đầu thấy khoá của
 * nó — rồi giữ nguyên chừng nào dòng còn trong danh sách. Class `unroll-row` + `--unroll-delay` vì thế không đổi
 * qua các lần render; CSS animation chỉ chạy khi phần tử mount, nên dòng cũ không chạy lại, còn dòng đang mở dở
 * không bị cắt ngang khi danh sách render lại. Dòng rời danh sách thì quên (quay lại = dòng mới).
 * TS thuần (không React) để jest test thẳng; hook mỏng ở use-unroll.ts.
 */

export const UNROLL_STAGGER_MS = 20;
export const UNROLL_STAGGER_CAP_MS = 200;
/** Thời lượng animation (khớp styles/unroll.css) + biên an toàn trước khi gỡ class. */
export const UNROLL_DURATION_MS = 220;
const UNROLL_SLACK_MS = 150;

export interface UnrollFate {
  animate: boolean;
  delayMs: number;
  /** Mốc (ms) sau đó dòng KHÔNG còn mang class: lần mount lại sau này (lọc client, cuộn) không mở ra lần nữa. */
  until: number;
}

export interface UnrollMemory {
  fates: Map<string, UnrollFate>;
  /** Đã thấy lô đầu tiên chưa — lô đầu có mở ra hay không tuỳ `animateInitial`. */
  primed: boolean;
}

export function createUnrollMemory(): UnrollMemory {
  return { fates: new Map(), primed: false };
}

/**
 * Gán số phận cho danh sách `keys` (theo thứ tự hiển thị) — truyền danh sách ĐẦY ĐỦ đã nạp, KHÔNG phải tập đã lọc phía
 * client (khoá vắng mặt bị quên -> hiện lại sẽ mở ra như dòng mới). Khoá mới trong cùng một lần gọi = một lô: trễ
 * `i * 20ms` theo thứ tự xuất hiện, trần 200ms. Trả map khoá -> số phận cho đúng các khoá đang hiển thị.
 */
export function assignUnroll(
  mem: UnrollMemory,
  keys: readonly string[],
  now: number,
  opts: { animateInitial?: boolean } = {},
): Map<string, UnrollFate> {
  const animateBatch = mem.primed || opts.animateInitial !== false;
  let n = 0;
  const visible = new Set(keys);
  for (const k of keys) {
    if (mem.fates.has(k)) continue;
    const delayMs = animateBatch ? Math.min(n++ * UNROLL_STAGGER_MS, UNROLL_STAGGER_CAP_MS) : 0;
    mem.fates.set(k, { animate: animateBatch, delayMs, until: animateBatch ? now + delayMs + UNROLL_DURATION_MS + UNROLL_SLACK_MS : 0 });
  }
  for (const k of [...mem.fates.keys()]) if (!visible.has(k)) mem.fates.delete(k);
  if (keys.length > 0) mem.primed = true;
  const out = new Map<string, UnrollFate>();
  for (const k of keys) out.set(k, mem.fates.get(k) as UnrollFate);
  return out;
}

/**
 * Dòng có mang class lúc render này không: chỉ trong cửa sổ animation của nó. Trong cửa sổ, class giữ nguyên qua
 * các lần render (không cắt ngang); hết cửa sổ thì gỡ — vô hình vì animation đã xong, và phần tử mount lại sau
 * đó (bị lọc ẩn rồi hiện lại) không chạy lại.
 */
export function isUnrolling(fate: UnrollFate | undefined, now: number): boolean {
  return fate?.animate === true && now < fate.until;
}

/** Quên hết (đổi bộ lọc / đổi project): danh sách mới là một lô mới. */
export function resetUnroll(mem: UnrollMemory): void {
  mem.fates.clear();
  mem.primed = false;
}
