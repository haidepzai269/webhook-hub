import { Suspense } from "react";

import type { Metadata } from "next";

import { AuthShell } from "../_components/auth-shell";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Đăng nhập — Webhook Hub",
};

export default function LoginPage() {
  return (
    <AuthShell title="ĐĂNG NHẬP" footerText="Chưa có tài khoản?" footerLinkLabel="Đăng ký" footerHref="/auth/register">
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
