"use client";

import { useEffect, useRef, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { UserPlus } from "lucide-react";

import { readCsrfCookie } from "@/lib/hub/client";

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
      setMessage("Không tìm thấy lời mời. Mở lại link trong email.");
      return;
    }
    fetch("/auth/me", { credentials: "include" })
      .then((r) => setState(r.ok ? "ready" : "anonymous"))
      .catch(() => setState("anonymous"));
  }, []);

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
          ? "Lời mời gửi cho email khác. Đăng xuất rồi đăng nhập bằng đúng email được mời."
          : data.error === "token_invalid"
            ? "Lời mời không hợp lệ, đã dùng hoặc đã hết hạn."
            : (data.message ?? `Không nhận được lời mời (HTTP ${res.status}).`),
      );
    } catch (err) {
      setState("error");
      setMessage(`Không kết nối được hub-api: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <AuthShell
      title="LỜI MỜI VÀO PROJECT"
      footerText="Chưa đăng nhập?"
      footerLinkLabel="Đăng nhập"
      footerHref="/login?next=/invite"
      social={false}
    >
      {state === "checking" && <p>Đang kiểm tra…</p>}
      {state === "anonymous" && (
        <p>
          Đăng nhập bằng <b>đúng email được mời</b> để nhận lời mời: <Link href="/login?next=/invite">Đăng nhập</Link>{" "}
          hoặc <Link href="/register?next=/invite">Đăng ký</Link>.
        </p>
      )}
      {(state === "ready" || state === "accepting") && (
        <button className={styles.button} type="button" onClick={accept} disabled={state === "accepting"}>
          <UserPlus size={16} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
          {state === "accepting" ? "ĐANG NHẬN…" : "NHẬN LỜI MỜI"}
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
