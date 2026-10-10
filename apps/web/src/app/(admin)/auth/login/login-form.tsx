"use client";

import { useEffect, useState } from "react";

import { useRouter, useSearchParams } from "next/navigation";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { HUB_API_URL } from "@/lib/env";
import { getToken, setToken } from "@/lib/hub/token";

import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

const formSchema = z.object({
  username: z.string().trim().min(1, { message: "Nhập tên đăng nhập." }),
  password: z.string().min(1, { message: "Nhập mật khẩu." }),
});

type LoginValues = z.infer<typeof formSchema>;

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<LoginValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { username: "", password: "" },
  });

  // Đã có token (vào thẳng /auth/login) → về dashboard; token sai thì 401 đầu tiên sẽ đưa lại đây.
  useEffect(() => {
    if (getToken() && !params.get("expired")) router.replace("/dashboard/flow");
  }, [params, router]);

  useEffect(() => {
    if (params.get("expired")) toast.warning("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  }, [params]);

  const onSubmit = async (values: LoginValues) => {
    setServerError(null);
    try {
      const res = await fetch(`${HUB_API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = (await res.json().catch(() => ({}))) as { accessToken?: string; message?: string };
      if (!res.ok) {
        setServerError(data.message ?? `Đăng nhập thất bại (HTTP ${res.status}).`);
        return;
      }
      if (!data.accessToken) {
        setServerError("Phản hồi đăng nhập không hợp lệ (thiếu accessToken).");
        return;
      }
      setToken(data.accessToken);
      router.replace("/dashboard/flow");
    } catch (e) {
      setServerError(`Không kết nối được hub-api: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <Controller
        control={form.control}
        name="username"
        render={({ field, fieldState }) => (
          <AuthField
            {...field}
            id="login-username"
            label="TÊN ĐĂNG NHẬP"
            placeholder="admin"
            autoComplete="username"
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
    </form>
  );
}
