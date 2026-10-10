"use client";

import { useState } from "react";

import { MailCheck } from "lucide-react";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import styles from "../_components/auth.module.css";
import { AuthField } from "../_components/auth-field";

/**
 * AU1 — form TRẦN (DINH-CHINH-AUTH §3: màn đăng ký đầy đủ để phiên UI). Luật mật khẩu thật do server kiểm
 * (SPEC-auth §5.2: ≥ 10 ký tự, ≤ 72 byte, không phổ biến, không chứa phần trước @) — form chỉ báo lỗi server trả.
 */
const formSchema = z
  .object({
    email: z.string().trim().min(1, { message: "Nhập email." }).email({ message: "Email không hợp lệ." }),
    name: z.string().trim().min(1, { message: "Nhập tên hiển thị." }).max(100),
    password: z.string().min(10, { message: "Mật khẩu tối thiểu 10 ký tự." }),
    confirmPassword: z.string().min(1, { message: "Nhập lại mật khẩu." }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Mật khẩu nhập lại không khớp.",
  });

type RegisterValues = z.infer<typeof formSchema>;

const FIELDS = [
  { name: "email", label: "EMAIL", type: "email", autoComplete: "email", placeholder: "ban@vi-du.com" },
  { name: "name", label: "TÊN HIỂN THỊ", type: "text", autoComplete: "name", placeholder: "Nguyễn An" },
  { name: "password", label: "MẬT KHẨU", type: "password", autoComplete: "new-password", placeholder: "••••••••••" },
  {
    name: "confirmPassword",
    label: "NHẬP LẠI MẬT KHẨU",
    type: "password",
    autoComplete: "new-password",
    placeholder: "••••••••••",
  },
] as const;

export function RegisterForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<RegisterValues>({
    resolver: zodResolver(formSchema),
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
        setServerError(`Thử quá nhiều lần. Đợi ${res.headers.get("Retry-After") ?? "vài"} giây rồi thử lại.`);
        return;
      }
      if (!res.ok) {
        setServerError(data.message ?? `Đăng ký thất bại (HTTP ${res.status}).`);
        return;
      }
      // R-6 (ADR-120): 201 luôn giống hệt và KHÔNG đăng nhập — link trong email xác minh rồi đăng nhập luôn.
      setSentTo(email);
    } catch (e) {
      setServerError(`Không kết nối được hub-api: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (sentTo) {
    return (
      <p>
        <MailCheck size={18} aria-hidden style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
        Đã gửi link kích hoạt tới <b>{sentTo}</b>. Mở link trong email, đặt mật khẩu để kích hoạt và vào dashboard. Không thấy thư? Đăng
        ký lại bằng cùng email để nhận link mới.
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
