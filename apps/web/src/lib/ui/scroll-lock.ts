/**
 * Khoá cuộn trang nền khi overlay TỰ VIẾT mở (storefront: giỏ, popup món, thanh toán, gallery, tìm kiếm).
 * Dialog/Sheet Radix của admin đã tự khoá (react-remove-scroll) — không dùng helper này cho chúng.
 *
 * - Đếm tham chiếu: hai overlay chồng nhau (giỏ → thanh toán) không mở khoá sớm khi một cái đóng.
 * - Bù bề rộng thanh cuộn bằng padding-right lúc khoá → nội dung không giật sang phải khi thanh cuộn trang biến mất.
 * - Trả lại ĐÚNG giá trị inline cũ khi mở khoá (không xoá style người khác đặt).
 */

export interface ScrollLockTarget {
  /** documentElement.clientWidth — bề rộng không gồm thanh cuộn */
  clientWidth: number;
  /** window.innerWidth — bề rộng gồm thanh cuộn */
  innerWidth: number;
  style: { overflow: string; paddingRight: string };
  /** padding-right đang tính (computed) của body, px */
  computedPaddingRight: number;
}

export interface ScrollLock {
  lock(): void;
  unlock(): void;
  readonly count: number;
}

export function createScrollLock(env: () => ScrollLockTarget | null): ScrollLock {
  let count = 0;
  let saved: { overflow: string; paddingRight: string } | null = null;
  return {
    get count() {
      return count;
    },
    lock() {
      count += 1;
      if (count > 1) return;
      const t = env();
      if (!t) return;
      saved = { overflow: t.style.overflow, paddingRight: t.style.paddingRight };
      const gap = Math.max(0, t.innerWidth - t.clientWidth);
      if (gap > 0) t.style.paddingRight = `${t.computedPaddingRight + gap}px`;
      t.style.overflow = "hidden";
    },
    unlock() {
      if (count === 0) return;
      count -= 1;
      if (count > 0) return;
      const t = env();
      if (!t || !saved) return;
      t.style.overflow = saved.overflow;
      t.style.paddingRight = saved.paddingRight;
      saved = null;
    },
  };
}

/** Khoá dùng chung của trình duyệt (một instance cho cả trang). */
export const bodyScrollLock = createScrollLock(() => {
  if (typeof document === "undefined") return null;
  const body = document.body;
  return {
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    style: body.style,
    computedPaddingRight: Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0,
  };
});
