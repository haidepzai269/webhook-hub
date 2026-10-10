"use client";

import { toast } from "sonner";

import styles from "./auth.module.css";

const PROVIDERS = [
  { key: "G", name: "Google" },
  { key: "F", name: "Facebook" },
  { key: "X", name: "X" },
] as const;

// hub-api chỉ có đăng nhập bằng tài khoản admin; nút giữ lại cho đúng bố cục mẫu.
export function SocialLogin() {
  return (
    <div className={styles.socialLogin}>
      {PROVIDERS.map(({ key, name }) => (
        <button
          key={key}
          type="button"
          className={styles.socialBtn}
          aria-label={`Đăng nhập bằng ${name}`}
          onClick={() => toast.info(`Đăng nhập bằng ${name} chưa được hỗ trợ.`)}
        >
          {key}
        </button>
      ))}
    </div>
  );
}
