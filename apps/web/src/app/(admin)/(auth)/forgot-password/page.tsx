"use client";

import { type FormEvent, useState } from "react";

import { MailCheck } from "lucide-react";

import { useT } from "@/lib/i18n/use-t";

import { AuthShell } from "../_components/auth-shell";
import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

/**
 * R-5 (review AU) — trang TRẦN, bản đầy đủ là việc của phiên UI. `POST /auth/forgot-password` luôn 202 dù email có
 * hay không (chống dò, SPEC-auth §5.2) nên trang chỉ nói "nếu có tài khoản thì đã gửi".
 */
export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setState("sending");
    setMessage(null);
    try {
      const res = await fetch("/auth/forgot-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.status === 429) {
        setState("error");
        setMessage(t("auth.rate-limited", { seconds: res.headers.get("Retry-After") ?? t("auth.rate-limited.some") }));
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setState("error");
        setMessage(data.message ?? t("auth.forgot.failed", { status: res.status }));
        return;
      }
      setState("sent");
    } catch (err) {
      setState("error");
      setMessage(t("auth.network-error", { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <AuthShell
      title={t("auth.forgot.title")}
      footerText={t("auth.forgot.footer")}
      footerLinkLabel={t("auth.sign-in")}
      footerHref="/login"
      social={false}
    >
      {state === "sent" ? (
        <p>
          <MailCheck size={18} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
          {t("auth.forgot.sent")}
        </p>
      ) : (
        <form noValidate onSubmit={onSubmit}>
          <AuthField
            id="forgot-email"
            label={t("auth.field.email")}
            type="email"
            placeholder={t("auth.placeholder.email")}
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {message && (
            <p role="alert" className={styles.serverError}>
              {message}
            </p>
          )}
          <button className={styles.button} type="submit" disabled={state === "sending" || !email.trim()}>
            {state === "sending" ? t("auth.forgot.submitting") : t("auth.forgot.submit")}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
