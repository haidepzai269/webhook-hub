"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { KeyRound } from "lucide-react";

import { useT } from "@/lib/i18n/use-t";

import { AuthShell } from "../_components/auth-shell";
import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

/**
 * AU2 — trang TRẦN (DINH-CHINH-AUTH §3: bản đầy đủ là việc của phiên UI). SPEC-auth §5.4: token đến qua URL ->
 * `Referrer-Policy: no-referrer` (next.config headers), giữ token trong ref rồi xoá query bằng `history.replaceState`.
 * R-6 (ADR-120): xác minh xong là ĐĂNG NHẬP. N-1 (ADR-121): tài khoản mật khẩu chưa xác minh -> server trả
 * `password_required` (token chưa bị đốt) -> người nắm hộp thư ĐẶT mật khẩu + tên; mật khẩu lúc đăng ký bị bỏ.
 */
export default function VerifyEmailPage() {
  const router = useRouter();
  const t = useT();
  const token = useRef<string | null>(null);
  const [state, setState] = useState<"pending" | "password" | "sending" | "ok" | "invalid">("pending");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (body: Record<string, string>) => {
    const r = await fetch("/auth/verify-email", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.current ?? "", ...body }),
    });
    if (r.ok) {
      setState("ok");
      let invite = false;
      try {
        invite = !!sessionStorage.getItem("hub_invite_token");
      } catch {
        // private mode
      }
      router.replace(invite ? "/invite" : "/dashboard");
      return;
    }
    const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    if (data.error === "password_required") return setState("password");
    if (data.error === "token_invalid") return setState("invalid");
    setState("password");
    setMessage(data.message ?? t("auth.verify.failed", { status: r.status }));
  };

  useEffect(() => {
    if (token.current !== null) return;
    token.current = new URLSearchParams(window.location.search).get("token") ?? "";
    window.history.replaceState(null, "", "/verify-email");
    submit({}).catch(() => setState("invalid"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setMessage(t("auth.validation.passwords-mismatch"));
    setMessage(null);
    setState("sending");
    await submit({ password, name: name.trim() }).catch((err) => {
      setState("password");
      setMessage(t("auth.network-error", { message: err instanceof Error ? err.message : String(err) }));
    });
  };

  return (
    <AuthShell
      title={t("auth.verify.title")}
      footerText={t("auth.verify.footer")}
      footerLinkLabel={t("auth.sign-in")}
      footerHref="/login"
      social={false}
    >
      {state === "pending" && <p>{t("auth.verify.pending")}</p>}
      {(state === "password" || state === "sending") && (
        <form noValidate onSubmit={onSubmit}>
          <p>
            <KeyRound size={18} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
            {t("auth.verify.intro")}
          </p>
          <AuthField id="verify-name" label={t("auth.field.name")} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          <AuthField
            id="verify-password"
            label={t("auth.field.password")}
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <AuthField id="verify-confirm" label={t("auth.field.confirm")} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {message && (
            <p role="alert" className={styles.serverError}>
              {message}
            </p>
          )}
          <button className={styles.button} type="submit" disabled={state === "sending" || !password}>
            {state === "sending" ? t("auth.verify.submitting") : t("auth.verify.submit")}
          </button>
        </form>
      )}
      {state === "ok" && (
        <p>
          {t("auth.verify.done")} <Link href="/dashboard">{t("auth.verify.go-dashboard")}</Link>
        </p>
      )}
      {state === "invalid" && (
        <p role="alert" className={styles.serverError}>
          {t("auth.verify.invalid")} <Link href="/forgot-password">{t("auth.forgot-short")}</Link>.
        </p>
      )}
    </AuthShell>
  );
}
