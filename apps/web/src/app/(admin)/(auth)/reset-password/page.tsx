"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import Link from "next/link";

import { KeyRound } from "lucide-react";

import { AuthShell } from "../_components/auth-shell";
import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

/**
 * R-5 (review AU) — trang TRẦN. Token đến qua URL: `Referrer-Policy: no-referrer` (next.config), giữ token trong
 * ref rồi xoá query bằng `history.replaceState` (SPEC-auth §5.4). Mật khẩu yếu -> 422, token KHÔNG bị đốt.
 */
export default function ResetPasswordPage() {
  const token = useRef<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (token.current !== null) return;
    token.current = new URLSearchParams(window.location.search).get("token") ?? "";
    window.history.replaceState(null, "", "/reset-password");
    if (!token.current) setMessage("Thiếu token. Mở lại link trong email, hoặc xin link mới.");
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setMessage("Hai mật khẩu không khớp.");
      return;
    }
    setState("sending");
    setMessage(null);
    try {
      const res = await fetch("/auth/reset-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.current ?? "", password }),
      });
      if (res.ok) {
        setState("done");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      setState("idle");
      setMessage(
        data.error === "token_invalid"
          ? "Link không hợp lệ, đã dùng hoặc đã hết hạn. Xin link mới."
          : (data.message ?? `Không đặt lại được (HTTP ${res.status}).`),
      );
    } catch (err) {
      setState("idle");
      setMessage(`Không kết nối được hub-api: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <AuthShell
      title="ĐẶT LẠI MẬT KHẨU"
      footerText="Cần link mới?"
      footerLinkLabel="Quên mật khẩu"
      footerHref="/forgot-password"
      social={false}
    >
      {state === "done" ? (
        <p>
          <KeyRound size={18} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
          Đã đặt mật khẩu mới. Mọi phiên đăng nhập cũ đã bị thu hồi. <Link href="/login">Đăng nhập</Link>
        </p>
      ) : (
        <form noValidate onSubmit={onSubmit}>
          <AuthField
            id="reset-password"
            label="MẬT KHẨU MỚI"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <AuthField
            id="reset-confirm"
            label="NHẬP LẠI"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {message && (
            <p role="alert" className={styles.serverError}>
              {message}
            </p>
          )}
          <button className={styles.button} type="submit" disabled={state === "sending" || !password}>
            {state === "sending" ? "ĐANG LƯU…" : "ĐẶT MẬT KHẨU"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
