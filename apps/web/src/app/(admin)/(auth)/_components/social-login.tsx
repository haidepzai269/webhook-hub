"use client";

import styles from "./auth.module.css";

/**
 * AU5 (SPEC-auth §5.10, §9): đăng nhập bằng GitHub. Điều hướng TOÀN TRANG tới `/auth/github` (qua proxy của web):
 * hub-api đặt cookie state/PKCE rồi chuyển sang GitHub; GitHub gọi lại `/auth/github/callback` (cũng qua proxy) nên
 * mọi cookie là first-party của domain web. Google/Facebook/X: ngoài phạm vi (spec §1) — đã bỏ nút giả.
 */
export function SocialLogin() {
  return (
    <div className={styles.socialLogin}>
      <a className={styles.socialBtn} href="/auth/github" aria-label="Đăng nhập bằng GitHub" title="Đăng nhập bằng GitHub">
        GH
      </a>
    </div>
  );
}
