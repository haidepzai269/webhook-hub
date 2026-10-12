"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import Link from "next/link";

import { useT } from "@/lib/i18n/use-t";

import styles from "./auth.module.css";
import { AuthVisual } from "./auth-visual";
import { SocialLogin } from "./social-login";

interface AuthShellProps {
  title: string;
  /** Một câu phụ dưới tiêu đề (chữ mờ). Không truyền thì không render. */
  subtitle?: string;
  children: ReactNode;
  footerText: string;
  footerLinkLabel: string;
  footerHref: string;
  /** Trang token (đặt lại mật khẩu, lời mời) không cần nút GitHub. */
  social?: boolean;
}

/** Khung chung mọi trang xác thực: trái = panel minh hoạ (trang trí), phải = form theo token theme của admin. */
export function AuthShell({
  title,
  subtitle,
  children,
  footerText,
  footerLinkLabel,
  footerHref,
  social = true,
}: AuthShellProps) {
  const t = useT();
  // Mô phỏng webhook mở → panel trái phóng toàn màn hình; form vẫn MOUNT (giữ chữ đã gõ) nhưng `inert`:
  // ra khỏi tab order + cây trợ năng. Thoát → hiện lại đúng như trước.
  const [simOpen, setSimOpen] = useState(false);
  // Lỗi đăng nhập (role=alert) về trong lúc form đang inert thì trình đọc màn hình không đọc → khi thoát mô phỏng,
  // đọc lại nội dung các alert của form qua một vùng aria-live riêng.
  const mainRef = useRef<HTMLElement>(null);
  const wasOpen = useRef<boolean>(false);
  const [reannounce, setReannounce] = useState("");
  useEffect(() => {
    if (wasOpen.current && !simOpen) {
      const alerts = mainRef.current?.querySelectorAll('[role="alert"]') ?? [];
      setReannounce([...alerts].map((a) => a.textContent ?? "").join(" "));
    }
    if (simOpen) setReannounce("");
    wasOpen.current = simOpen;
  }, [simOpen]);
  return (
    <div className={styles.page} data-sim={simOpen ? "on" : undefined}>
      <AuthVisual onSimChange={setSimOpen} />
      <p className={styles.srOnly} aria-live="assertive">
        {reannounce}
      </p>
      <main ref={mainRef} className={styles.formPanel} inert={simOpen}>
        <div className={styles.container}>
          <header className={styles.header}>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </header>
          {children}
          {social && (
            <>
              <div className={styles.divider}>{t("auth.or")}</div>
              <SocialLogin />
            </>
          )}
          <p className={styles.footer}>
            {footerText} <Link href={footerHref}>{footerLinkLabel}</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
