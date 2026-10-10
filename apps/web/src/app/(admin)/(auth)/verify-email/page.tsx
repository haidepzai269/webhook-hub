"use client";

import { useEffect, useRef, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { AuthShell } from "../_components/auth-shell";
import styles from "../_components/auth.module.css";

/**
 * AU2 — trang TRẦN (DINH-CHINH-AUTH §3: bản đầy đủ là việc của phiên UI). SPEC-auth §5.4: token đến qua URL ->
 * `Referrer-Policy: no-referrer` (next.config headers), POST token NGAY, rồi xoá query bằng `history.replaceState`.
 * R-6 (ADR-120): xác minh xong là ĐĂNG NHẬP (server đặt cookie) -> đi tiếp `/invite` nếu đang nhận lời mời, không thì
 * dashboard.
 */
export default function VerifyEmailPage() {
  const router = useRouter();
  const [state, setState] = useState<"pending" | "ok" | "invalid">("pending");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    window.history.replaceState(null, "", "/verify-email");
    fetch("/auth/verify-email", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((r) => {
        if (!r.ok) return setState("invalid");
        setState("ok");
        let invite = false;
        try {
          invite = !!sessionStorage.getItem("hub_invite_token");
        } catch {
          // private mode
        }
        router.replace(invite ? "/invite" : "/dashboard");
      })
      .catch(() => setState("invalid"));
  }, [router]);

  return (
    <AuthShell title="XÁC MINH EMAIL" footerText="Quay lại" footerLinkLabel="Đăng nhập" footerHref="/login" social={false}>
      {state === "pending" && <p>Đang xác minh…</p>}
      {state === "ok" && (
        <p>
          Email đã được xác minh. <Link href="/dashboard">Vào dashboard</Link>
        </p>
      )}
      {state === "invalid" && (
        <p role="alert" className={styles.serverError}>
          Link không hợp lệ, đã dùng hoặc đã hết hạn. Đăng ký lại bằng cùng email để nhận link mới, hoặc dùng{" "}
          <Link href="/forgot-password">Quên mật khẩu</Link>.
        </p>
      )}
    </AuthShell>
  );
}
