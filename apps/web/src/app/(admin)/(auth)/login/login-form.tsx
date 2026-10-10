"use client";

import { useEffect, useState } from "react";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";


import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";
import { safeNext } from "../_components/next-path";

const formSchema = z.object({
  email: z.string().trim().min(1, { message: "Nhập email." }).email({ message: "Email không hợp lệ." }),
  password: z.string().min(1, { message: "Nhập mật khẩu." }),
});

type LoginValues = z.infer<typeof formSchema>;

const GITHUB_ERRORS: Record<string, string> = {
  github_failed: "GitHub không phản hồi. Thử lại sau.",
  github_email_unverified: "Tài khoản GitHub chưa có email chính đã xác minh.",
  email_exists_unverified: "Email này đã đăng ký nhưng chưa xác minh. Đăng nhập bằng mật khẩu hoặc dùng Quên mật khẩu.",
  github_account_mismatch: "Tài khoản này đã liên kết với một tài khoản GitHub khác.",
  operator_github_forbidden: "Operator không đăng nhập bằng GitHub.",
};

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<LoginValues>({
    resolver: zodResolver(formSchema),
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
    if (params.get("expired")) toast.warning("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  }, [params]);

  // Lỗi từ callback GitHub (`/login?error=…`, github-oauth.service).
  useEffect(() => {
    const code = params.get("error");
    if (code) setServerError(GITHUB_ERRORS[code] ?? `Đăng nhập GitHub thất bại (${code}).`);
  }, [params]);

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
        setServerError(`Thử quá nhiều lần. Đợi ${res.headers.get("Retry-After") ?? "vài"} giây rồi thử lại.`);
        return;
      }
      if (res.status === 401) {
        // R-6: tài khoản chưa xác minh cũng nhận CÙNG 401 (chống dò) — nhắc cả hai khả năng.
        setServerError("Email hoặc mật khẩu không đúng, hoặc email chưa xác minh (mở link trong thư kích hoạt).");
        return;
      }
      if (!res.ok) {
        setServerError(data.message ?? `Đăng nhập thất bại (HTTP ${res.status}).`);
        return;
      }
      router.replace(safeNext(params.get("next")));
    } catch (e) {
      setServerError(`Không kết nối được hub-api: ${e instanceof Error ? e.message : String(e)}`);
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
            label="EMAIL"
            type="email"
            placeholder="ban@vi-du.com"
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
            label="MẬT KHẨU"
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
        {form.formState.isSubmitting ? "ĐANG ĐĂNG NHẬP…" : "ĐĂNG NHẬP"}
      </button>
      <p className={styles.footer}>
        <Link href="/forgot-password">Quên mật khẩu?</Link>
      </p>
    </form>
  );
}
