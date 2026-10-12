"use client";

import { useMemo, useState } from "react";

import { MailCheck } from "lucide-react";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import type { MessageKey, TranslateFn } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

/**
 * AU1 — form TRẦN (DINH-CHINH-AUTH §3: màn đăng ký đầy đủ để phiên UI). Luật mật khẩu thật do server kiểm
 * (SPEC-auth §5.2: ≥ 10 ký tự, ≤ 72 byte, không phổ biến, không chứa phần trước @) — form chỉ báo lỗi server trả.
 */
const makeSchema = (t: TranslateFn) =>
  z
    .object({
      email: z
        .string()
        .trim()
        .min(1, { message: t("auth.validation.email-required") })
        .email({ message: t("auth.validation.email-invalid") }),
      name: z.string().trim().min(1, { message: t("auth.validation.name-required") }).max(100),
      password: z.string().min(10, { message: t("auth.validation.password-min") }),
      confirmPassword: z.string().min(1, { message: t("auth.validation.confirm-required") }),
    })
    .refine((v) => v.password === v.confirmPassword, {
      path: ["confirmPassword"],
      message: t("auth.validation.confirm-mismatch"),
    });

type RegisterValues = z.infer<ReturnType<typeof makeSchema>>;

// Nhãn là KHOÁ i18n; placeholder là khoá `auth.*` hoặc chuỗi không chữ (••••).
const FIELDS: readonly {
  name: keyof RegisterValues;
  label: MessageKey;
  type: string;
  autoComplete: string;
  placeholder: MessageKey | string;
}[] = [
  { name: "email", label: "auth.field.email", type: "email", autoComplete: "email", placeholder: "auth.placeholder.email" },
  { name: "name", label: "auth.field.name", type: "text", autoComplete: "name", placeholder: "auth.placeholder.name" },
  { name: "password", label: "auth.field.password", type: "password", autoComplete: "new-password", placeholder: "••••••••••" },
  {
    name: "confirmPassword",
    label: "auth.field.confirm-password",
    type: "password",
    autoComplete: "new-password",
    placeholder: "••••••••••",
  },
];

export function RegisterForm() {
  const t = useT();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<RegisterValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", name: "", password: "", confirmPassword: "" },
  });

  const onSubmit = async ({ email, name, password }: RegisterValues) => {
    setServerError(null);
    try {
      const res = await fetch("/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.status === 429) {
        setServerError(
          t("auth.rate-limited", { seconds: res.headers.get("Retry-After") ?? t("auth.rate-limited.some") }),
        );
        return;
      }
      if (!res.ok) {
        setServerError(data.message ?? t("auth.register.failed", { status: res.status }));
        return;
      }
      // R-6 (ADR-120): 201 luôn giống hệt và KHÔNG đăng nhập — link trong email xác minh rồi đăng nhập luôn.
      setSentTo(email);
    } catch (e) {
      setServerError(t("auth.network-error", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  if (sentTo) {
    return (
      <p>
        <MailCheck size={18} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
        {t("auth.register.sent-before")} <b>{sentTo}</b>. {t("auth.register.sent-after")}
      </p>
    );
  }

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      {FIELDS.map(({ name, label, type, autoComplete, placeholder }) => (
        <Controller
          key={name}
          control={form.control}
          name={name}
          render={({ field, fieldState }) => (
            <AuthField
              {...field}
              id={`register-${name}`}
              label={t(label)}
              type={type}
              placeholder={placeholder.startsWith("auth.") ? t(placeholder as MessageKey) : placeholder}
              autoComplete={autoComplete}
              error={fieldState.error?.message}
            />
          )}
        />
      ))}
      {serverError && (
        <p role="alert" className={styles.serverError}>
          {serverError}
        </p>
      )}
      <button className={styles.button} type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t("auth.register.submitting") : t("auth.register.submit")}
      </button>
    </form>
  );
}
