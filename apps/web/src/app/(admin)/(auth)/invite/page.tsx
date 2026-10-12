"use client";

import { useEffect, useRef, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { UserPlus } from "lucide-react";

import { readCsrfCookie } from "@/lib/hub/client";
import { useT } from "@/lib/i18n/use-t";

import { AuthShell } from "../_components/auth-shell";
import styles from "../_components/auth.module.css";

const STORE = "hub_invite_token";

function readToken(): string {
  try {
    return sessionStorage.getItem(STORE) ?? "";
  } catch {
    return "";
  }
}

/**
 * R-5 (review AU) — nhận lời mời (AU4). Token qua URL -> giữ trong sessionStorage (còn dùng được sau khi đăng nhập /
 * đăng ký qua `?next=/invite`) rồi xoá query (`replaceState`, `no-referrer`). Chưa đăng nhập -> mời đăng nhập bằng
 * ĐÚNG email được mời; đã đăng nhập -> `POST /auth/invitations/accept` (kèm CSRF).
 */
export default function InvitePage() {
  const router = useRouter();
  const t = useT();
  const started = useRef(false);
  const [state, setState] = useState<"checking" | "anonymous" | "ready" | "accepting" | "error">("checking");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) {
      try {
        sessionStorage.setItem(STORE, fromUrl);
      } catch {
        // private mode: token chỉ sống trong trang này
      }
      window.history.replaceState(null, "", "/invite");
    }
    if (!fromUrl && !readToken()) {
      setState("error");
      setMessage(t("auth.invite.not-found"));
      return;
    }
    fetch("/auth/me", { credentials: "include" })
      .then((r) => setState(r.ok ? "ready" : "anonymous"))
      .catch(() => setState("anonymous"));
  }, [t]);

  const accept = async () => {
    setState("accepting");
    setMessage(null);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const csrf = readCsrfCookie();
    if (csrf) headers["x-csrf-token"] = csrf;
    try {
      const res = await fetch("/auth/invitations/accept", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ token: readToken() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (res.ok) {
        try {
          sessionStorage.removeItem(STORE);
        } catch {
          // bỏ qua
        }
        router.replace("/dashboard");
        return;
      }
      setState(res.status === 401 ? "anonymous" : "error");
      setMessage(
        data.error === "invite_email_mismatch"
          ? t("auth.invite.email-mismatch")
          : data.error === "token_invalid"
            ? t("auth.invite.invalid")
            : (data.message ?? t("auth.invite.failed", { status: res.status })),
      );
    } catch (err) {
      setState("error");
      setMessage(t("auth.network-error", { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <AuthShell
      title={t("auth.invite.title")}
      footerText={t("auth.invite.footer")}
      footerLinkLabel={t("auth.sign-in")}
      footerHref="/login?next=/invite"
      social={false}
    >
      {state === "checking" && <p>{t("auth.invite.checking")}</p>}
      {state === "anonymous" && (
        <p>
          {t("auth.invite.sign-in-before")} <b>{t("auth.invite.sign-in-email")}</b> {t("auth.invite.sign-in-after")}{" "}
          <Link href="/login?next=/invite">{t("auth.sign-in")}</Link> {t("auth.invite.or")}{" "}
          <Link href="/register?next=/invite">{t("auth.sign-up")}</Link>.
        </p>
      )}
      {(state === "ready" || state === "accepting") && (
        <button className={styles.button} type="button" onClick={accept} disabled={state === "accepting"}>
          <UserPlus size={16} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
          {state === "accepting" ? t("auth.invite.accepting") : t("auth.invite.accept")}
        </button>
      )}
      {message && (
        <p role="alert" className={styles.serverError}>
          {message}
        </p>
      )}
    </AuthShell>
  );
}
