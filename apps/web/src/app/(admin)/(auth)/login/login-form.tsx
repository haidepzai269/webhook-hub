"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

/**
 * Dải 4 bước trên nút gửi — "đăng nhập là một sự kiện". CHỈ là trình bày, suy ra từ luồng fetch có sẵn:
 * "gửi" → "xác thực" chạy theo đồng hồ khi request đang bay; "phiên" + "200" chỉ sáng khi server trả `res.ok` THẬT
 * (client không bao giờ giả thành công, như BB-3: không 2xx trước COMMIT). Lỗi bất kỳ → dừng đỏ ở "xác thực".
 */
type Phase = "idle" | "pending" | "ok" | "failed";
const STEPS = ["sent", "verified", "session", "ok"] as const;
type StepState = "todo" | "active" | "done" | "failed";
const VERIFY_STEP_DELAY_MS = 400;

function stepState(phase: Phase, reached: number, index: number): StepState {
  if (phase === "ok") return "done";
  if (phase === "failed") {
    if (index === 1) return "failed";
    return index < 1 ? "done" : "todo";
  }
  if (index < reached - 1) return "done";
  return index === reached - 1 ? "active" : "todo";
}

function EventSteps({ phase, reached, t }: { phase: Phase; reached: number; t: TranslateFn }) {
  return (
    <span className={styles.steps} aria-hidden="true">
      {STEPS.map((step, i) => (
        <span key={step} className={styles.step} data-state={stepState(phase, reached, i)}>
          {t(`auth.login.step.${step}`)}
        </span>
      ))}
    </span>
  );
}

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
  const [phase, setPhase] = useState<Phase>("idle");
  const [reached, setReached] = useState(0);
  const stepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(stepTimer.current), []);
  const settle = (ok: boolean) => {
    clearTimeout(stepTimer.current);
    setPhase(ok ? "ok" : "failed");
    setReached(ok ? STEPS.length : 2);
  };
  const schema = useMemo(() => makeSchema(t), [t]);
  // Resolver đọc schema qua ref: đổi ngôn ngữ → schema mới có hiệu lực ngay, không phụ thuộc useForm có nhận resolver mới.
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
  const form = useForm<LoginValues>({
    resolver: (values, context, options) => zodResolver(schemaRef.current)(values, context, options),
    defaultValues: { email: "", password: "" },
  });

  // Đổi ngôn ngữ khi đang hiện lỗi → kiểm tra lại các ô đó để câu lỗi theo ngôn ngữ mới.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `schema` là tín hiệu đổi ngôn ngữ, không đọc trong thân effect.
  useEffect(() => {
    const names = Object.keys(form.formState.errors) as (keyof LoginValues)[];
    if (names.length) void form.trigger(names);
  }, [schema, form]);

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
        OAUTH_ERRORS.has(code)
          ? t(`auth.oauth.${code.replaceAll("_", "-")}` as MessageKey)
          : t("auth.login.oauth-failed", { code }),
      );
  }, [params, t]);

  const onSubmit = async (values: LoginValues) => {
    setServerError(null);
    clearTimeout(stepTimer.current);
    setPhase("pending");
    setReached(1);
    stepTimer.current = setTimeout(() => setReached(2), VERIFY_STEP_DELAY_MS);
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
        settle(false);
        setServerError(
          t("auth.rate-limited", { seconds: res.headers.get("Retry-After") ?? t("auth.rate-limited.some") }),
        );
        return;
      }
      if (res.status === 401) {
        // R-6: tài khoản chưa xác minh cũng nhận CÙNG 401 (chống dò) — nhắc cả hai khả năng.
        settle(false);
        setServerError(t("auth.login.bad-credentials"));
        return;
      }
      if (!res.ok) {
        settle(false);
        setServerError(data.message ?? t("auth.login.failed", { status: res.status }));
        return;
      }
      settle(true);
      router.replace(safeNext(params.get("next")));
    } catch (e) {
      settle(false);
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
      {/* phase "ok": giữ khoá trong lúc router.replace — bấm lần nữa sẽ POST lại và dải bước tụt về pending. */}
      <button className={styles.button} type="submit" disabled={form.formState.isSubmitting || phase === "ok"}>
        {phase === "pending" || phase === "ok" ? (
          <>
            <span className={styles.srOnly}>{t("auth.login.submitting")}</span>
            <EventSteps phase={phase} reached={reached} t={t} />
          </>
        ) : (
          t("auth.login.submit")
        )}
      </button>
      {phase === "failed" && (
        <div className={styles.stepsFailed}>
          <EventSteps phase={phase} reached={reached} t={t} />
        </div>
      )}
      {/* Chỉ đọc khi pending/ok. Thất bại: để role="alert" của serverError đọc một mình (khỏi đọc hai lần,
          và 429/lỗi mạng không phải "dừng ở xác thực"); dải hình vẫn dừng đỏ ở "xác thực". */}
      <span className={styles.srOnly} aria-live="polite">
        {phase === "pending" && t(reached >= 2 ? "auth.login.live.verified" : "auth.login.live.sent")}
        {phase === "ok" && t("auth.login.live.ok")}
      </span>
      <p className={styles.footer}>
        <Link href="/forgot-password">{t("auth.forgot-link")}</Link>
      </p>
    </form>
  );
}
