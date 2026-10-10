"use client";

import { useEffect, useRef, useState } from "react";

import Link from "next/link";

import { AuthShell } from "../_components/auth-shell";
import styles from "../_components/auth.module.css";

/**
 * AU2 — trang TRẦN (DINH-CHINH-AUTH §3: bản đầy đủ là việc của phiên UI). SPEC-auth §5.4: token đến qua URL ->
 * `Referrer-Policy: no-referrer` (next.config headers), POST token NGAY, rồi xoá query bằng `history.replaceState`.
 */
export default function VerifyEmailPage() {
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
      .then((r) => setState(r.ok ? "ok" : "invalid"))
      .catch(() => setState("invalid"));
  }, []);

  return (
    <AuthShell title="XÁC MINH EMAIL" footerText="Quay lại" footerLinkLabel="Đăng nhập" footerHref="/login">
      {state === "pending" && <p>Đang xác minh…</p>}
      {state === "ok" && (
        <p>
          Email đã được xác minh. <Link href="/dashboard/flow">Vào dashboard</Link>
        </p>
      )}
      {state === "invalid" && (
        <p role="alert" className={styles.serverError}>
          Link không hợp lệ, đã dùng hoặc đã hết hạn. Đăng nhập rồi bấm &quot;Gửi lại email xác minh&quot;.
        </p>
      )}
    </AuthShell>
  );
}
