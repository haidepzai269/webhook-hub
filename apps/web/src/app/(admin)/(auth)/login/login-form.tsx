"use client";

import { useEffect, useMemo, useState } from "react";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import type { MessageKey, TranslateFn } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";
import { safeNext } from "../_components/next-path";

const makeSchema = (t: TranslateFn) =>
  z.object({
    email: z
      .string()
      .trim()
      .min(1, { message: t("auth.validation.email-required") })
      .email({ message: t("auth.validation.email-invalid") }),
    password: z.string().min(1, { message: t("auth.validation.password-required") }),
  });

type LoginValues = z.infer<ReturnType<typeof makeSchema>>;

/** Mã lỗi callback OAuth (`/login?error=…`) -> khoá i18n; mã lạ rơi về câu chung kèm mã. */
const OAUTH_ERRORS = new Set([
  "github_failed",
  "github_email_unverified",
  "email_exists_unverified",
  "github_account_mismatch",
  "operator_github_forbidden",
  "google_denied",
  "google_failed",
  "google_email_unverified",
  "google_account_mismatch",
  "operator_google_forbidden",
  "google_link_requires_password",
]);

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const t = useT();
  const [serverError, setServerError] = useState<string | null>(null);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  // Đã đăng nhập (cookie còn sống) → về dashboard. Không đọc token: cookie phiên là HttpOnly (SPEC-auth §4).
  useEffect(() => {
    if (params.get("expired")) return;
    fetch("/auth/me", { credentials: "include" })
      .then((r) => r.ok && router.replace(safeNext(params.get("next"))))
      .catch(() => undefined);
  }, [params, router]);

  useEffect(() => {
    if (params.get("expired")) toast.warning(t("auth.login.expired"));
  }, [params, t]);

  // Lỗi từ callback GitHub (`/login?error=…`, github-oauth.service).
  useEffect(() => {
    const code = params.get("error");
    if (code)
      setServerError(
        OAUTH_ERRORS.has(code) ? t(`auth.oauth.${code.replaceAll("_", "-")}` as MessageKey) : t("auth.login.oauth-failed", { code }),
      );
  }, [params, t]);

  const onSubmit = async (values: LoginValues) => {
    setServerError(null);
    try {
      // Qua proxy của web (cookie first-party). Token KHÔNG nằm trong body — server đặt cookie HttpOnly.
      const res = await fetch("/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (res.status === 429) {
        setServerError(
          t("auth.rate-limited", { seconds: res.headers.get("Retry-After") ?? t("auth.rate-limited.some") }),
        );
        return;
      }
      if (res.status === 401) {
        // R-6: tài khoản chưa xác minh cũng nhận CÙNG 401 (chống dò) — nhắc cả hai khả năng.
        setServerError(t("auth.login.bad-credentials"));
        return;
      }
      if (!res.ok) {
        setServerError(data.message ?? t("auth.login.failed", { status: res.status }));
        return;
      }
      router.replace(safeNext(params.get("next")));
    } catch (e) {
      setServerError(t("auth.network-error", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <Controller
        control={form.control}
        name="email"
        render={({ field, fieldState }) => (
          <AuthField
            {...field}
            id="login-email"
            label={t("auth.field.email")}
            type="email"
            placeholder={t("auth.placeholder.email")}
            autoComplete="email"
            autoFocus
            error={fieldState.error?.message}
          />
        )}
      />
      <Controller
        control={form.control}
        name="password"
        render={({ field, fieldState }) => (
          <AuthField
            {...field}
            id="login-password"
            label={t("auth.field.password")}
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            error={fieldState.error?.message}
          />
        )}
      />
      {serverError && (
        <p role="alert" className={styles.serverError}>
          {serverError}
        </p>
      )}
      <button className={styles.button} type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t("auth.login.submitting") : t("auth.login.submit")}
      </button>
      <p className={styles.footer}>
        <Link href="/forgot-password">{t("auth.forgot-link")}</Link>
      </p>
    </form>
  );
}
