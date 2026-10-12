import { Suspense } from "react";

import type { Metadata } from "next";

import { getT } from "@/lib/i18n/server";

import { AuthShell } from "../_components/auth-shell";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("auth.login.meta-title") };
}

export default async function LoginPage() {
  const t = await getT();
  return (
    <AuthShell
      title={t("auth.login.title")}
      footerText={t("auth.login.footer")}
      footerLinkLabel={t("auth.sign-up")}
      footerHref="/register"
    >
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
