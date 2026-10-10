import type { ReactNode } from "react";

import Link from "next/link";

import styles from "./auth.module.css";
import { SocialLogin } from "./social-login";

interface AuthShellProps {
  title: string;
  children: ReactNode;
  footerText: string;
  footerLinkLabel: string;
  footerHref: string;
}

export function AuthShell({ title, children, footerText, footerLinkLabel, footerHref }: AuthShellProps) {
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>{title}</h1>
        {children}
        <div className={styles.divider}>HOẶC</div>
        <SocialLogin />
        <p className={styles.footer}>
          {footerText} <Link href={footerHref}>{footerLinkLabel}</Link>
        </p>
      </div>
    </main>
  );
}
