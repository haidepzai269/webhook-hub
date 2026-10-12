import type { ComponentProps, ReactNode } from "react";

import styles from "./auth.module.css";

interface AuthFieldProps extends ComponentProps<"input"> {
  id: string;
  label: string;
  error?: string;
  /**
   * Gợi ý bất đồng bộ dưới ô (ADR-180: "email đã có tài khoản"). Truyền `null` để GIỮ vùng `aria-live` luôn có trong DOM
   * (trình đọc màn hình chỉ đọc thay đổi của vùng đã tồn tại); `undefined` = ô không có gợi ý.
   */
  hint?: ReactNode;
}

export function AuthField({ id, label, error, hint, ...input }: AuthFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={styles.inputGroup}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input {...input} id={id} className={styles.input} aria-invalid={Boolean(error)} aria-describedby={describedBy} />
      {error && (
        <p id={errorId} className={styles.fieldError}>
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p id={hintId} className={styles.fieldHint} aria-live="polite">
          {hint}
        </p>
      )}
    </div>
  );
}
