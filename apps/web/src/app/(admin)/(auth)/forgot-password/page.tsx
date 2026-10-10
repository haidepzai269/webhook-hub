"use client";

import { type FormEvent, useState } from "react";

import { MailCheck } from "lucide-react";

import { AuthShell } from "../_components/auth-shell";
import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

/**
 * R-5 (review AU) — trang TRẦN, bản đầy đủ là việc của phiên UI. `POST /auth/forgot-password` luôn 202 dù email có
 * hay không (chống dò, SPEC-auth §5.2) nên trang chỉ nói "nếu có tài khoản thì đã gửi".
 */
export default function ForgotPasswordPage() {
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
        setMessage(`Thử quá nhiều lần. Đợi ${res.headers.get("Retry-After") ?? "vài"} giây rồi thử lại.`);
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setState("error");
        setMessage(data.message ?? `Không gửi được (HTTP ${res.status}).`);
        return;
      }
      setState("sent");
    } catch (err) {
      setState("error");
      setMessage(`Không kết nối được hub-api: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <AuthShell title="QUÊN MẬT KHẨU" footerText="Nhớ ra rồi?" footerLinkLabel="Đăng nhập" footerHref="/login" social={false}>
      {state === "sent" ? (
        <p>
          <MailCheck size={18} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
          Nếu email này có tài khoản, link đặt lại mật khẩu đã được gửi. Link chỉ dùng được một lần.
        </p>
      ) : (
        <form noValidate onSubmit={onSubmit}>
          <AuthField
            id="forgot-email"
            label="EMAIL"
            type="email"
            placeholder="ban@vi-du.com"
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
            {state === "sending" ? "ĐANG GỬI…" : "GỬI LINK ĐẶT LẠI"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
