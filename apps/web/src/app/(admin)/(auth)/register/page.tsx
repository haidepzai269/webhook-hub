import type { Metadata } from "next";

import { AuthShell } from "../_components/auth-shell";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = {
  title: "Đăng ký — Webhook Hub",
};

export default function RegisterPage() {
  return (
    <AuthShell title="ĐĂNG KÝ" footerText="Đã có tài khoản?" footerLinkLabel="Đăng nhập" footerHref="/login">
      <RegisterForm />
    </AuthShell>
  );
}
