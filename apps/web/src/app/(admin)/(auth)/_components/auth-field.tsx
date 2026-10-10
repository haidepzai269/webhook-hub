import type { ComponentProps } from "react";

import styles from "./auth.module.css";

interface AuthFieldProps extends ComponentProps<"input"> {
  id: string;
  label: string;
  error?: string;
}

export function AuthField({ id, label, error, ...input }: AuthFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className={styles.inputGroup}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        className={styles.input}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} className={styles.fieldError}>
          {error}
        </p>
      )}
    </div>
  );
}
