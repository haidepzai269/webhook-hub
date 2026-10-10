"use client";

import { useState } from "react";

import { useRouter } from "next/navigation";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { HUB_API_URL } from "@/lib/env";
import { setToken } from "@/lib/hub/token";

import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

const formSchema = z
  .object({
    username: z.string().trim().min(3, { message: "Tên đăng nhập tối thiểu 3 ký tự." }),
    password: z.string().min(8, { message: "Mật khẩu tối thiểu 8 ký tự." }),
    confirmPassword: z.string().min(1, { message: "Nhập lại mật khẩu." }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Mật khẩu nhập lại không khớp.",
  });

type RegisterValues = z.infer<typeof formSchema>;

const FIELDS = [
  { name: "username", label: "TÊN ĐĂNG NHẬP", type: "text", autoComplete: "username", placeholder: "admin" },
  { name: "password", label: "MẬT KHẨU", type: "password", autoComplete: "new-password", placeholder: "••••••••" },
  {
    name: "confirmPassword",
    label: "NHẬP LẠI MẬT KHẨU",
    type: "password",
    autoComplete: "new-password",
    placeholder: "••••••••",
  },
] as const;

export function RegisterForm() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<RegisterValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { username: "", password: "", confirmPassword: "" },
  });

  const onSubmit = async ({ username, password }: RegisterValues) => {
    setServerError(null);
    try {
      const res = await fetch(`${HUB_API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { accessToken?: string; message?: string };
      if (res.status === 404 || res.status === 405) {
        setServerError("hub-api chưa mở endpoint đăng ký (POST /auth/register).");
        return;
      }
      if (!res.ok) {
        setServerError(data.message ?? `Đăng ký thất bại (HTTP ${res.status}).`);
        return;
      }
      if (data.accessToken) {
        setToken(data.accessToken);
        router.replace("/dashboard");
        return;
      }
      toast.success("Đăng ký thành công. Mời đăng nhập.");
      router.push("/auth/login");
    } catch (e) {
      setServerError(`Không kết nối được hub-api: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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
              label={label}
              type={type}
              placeholder={placeholder}
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
        {form.formState.isSubmitting ? "ĐANG ĐĂNG KÝ…" : "ĐĂNG KÝ"}
      </button>
    </form>
  );
}
