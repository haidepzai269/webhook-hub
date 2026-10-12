import type { Metadata } from "next";

import { getT } from "@/lib/i18n/server";

import { AuthShell } from "../_components/auth-shell";
import { RegisterForm } from "./register-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("auth.register.meta-title") };
}

export default async function RegisterPage() {
  const t = await getT();
  return (
    <AuthShell
      title={t("auth.register.title")}
      subtitle={t("auth.register.subtitle")}
      footerText={t("auth.register.footer")}
      footerLinkLabel={t("auth.sign-in")}
      footerHref="/login"
    >
      <RegisterForm />
    </AuthShell>
  );
}
