"use client";

import { useEffect, useRef, useState } from "react";

import { toast } from "sonner";

import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { alertActions } from "@/lib/alerts/links";
import { type BannerEntry, bannerAck, bannerAdd, bannerAnnounceKey, bannerMotion, selectBanner } from "@/lib/alerts/notify-logic";
import { useAckAlert, useSubjectNames } from "@/lib/hub/alert-queries";
import { useIsOperator } from "@/lib/hub/me-store";
import { useT } from "@/lib/i18n/use-t";

import { ProjectChip, SeverityIcon, useAlertText, useAlertUiStore, useOpenAlertTarget, usePrefersReducedMotion } from "./alert-ui";

/**
 * CB4 §8.2: banner critical — dính đầu vùng nội dung dashboard (dưới header), viền trái 4px `--danger`, nền
 * `--danger-subtle`. MỘT banner cho nhiều critical (+k mở chuông). Sống qua chuyển trang tới khi "Đã xem" hoặc RESOLVED;
 * RESOLVED -> xanh "Đã ổn trở lại" 4s rồi thu lại. Trượt xuống 200ms + mờ; giảm chuyển động -> chỉ mờ.
 * Chỉ critical nhận qua `alert.changed` TRONG PHIÊN mới vào đây (AlertNotifier) — tải trang không bật banner cũ.
 */
export function AlertBanner() {
  const operator = useIsOperator();
  const banner = useAlertUiStore((s) => s.banner);
  const { primary, more } = selectBanner(banner);
  const reduced = usePrefersReducedMotion();
  const motion = bannerMotion(reduced);

  // Giữ banner cuối cùng thêm 200ms để chạy hiệu ứng thu lại khi không còn gì để hiện.
  const [shown, setShown] = useState<{ entry: BannerEntry; more: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (primary) {
      setShown({ entry: primary, more });
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const id = setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, motion.durationMs);
    return () => clearTimeout(id);
  }, [primary, more, motion.durationMs]);

  if (!operator) return null;
  return (
    <>
      <Announcer entry={primary} />
      {shown && (
        <div
          className="sticky top-2 z-30 mb-4 [html[data-navbar-style=sticky]_&]:top-14"
          style={{ animation: `${leaving ? motion.exit : motion.enter} ${motion.durationMs}ms ease-out both` }}
          key={shown.entry.alert.id}
        >
          <BannerBody entry={shown.entry} more={shown.more} />
        </div>
      )}
    </>
  );
}

/**
 * Review TB3: vùng `aria-live` RIÊNG, ẩn, luôn có mặt — chỉ ghi MỘT lần cho mỗi cảnh báo (lúc hiện) và một lần lúc đã
 * ổn. Poll 30s vẽ lại banner (số liệu, "+k") nhưng không làm trình đọc màn hình đọc lại; số đếm/câu fix ở ngoài vùng này.
 */
function Announcer({ entry }: { entry: BannerEntry | null }) {
  const t = useT();
  const text = useAlertText();
  const nameOf = useSubjectNames(entry ? [entry.alert] : []);
  const [message, setMessage] = useState("");
  const last = useRef<string | null>(null);
  const key = bannerAnnounceKey(entry);
  // Chỉ chạy khi KHOÁ đổi — câu được chốt lúc đó; đổi ngôn ngữ/tên đối tượng sau không đọc lại.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cố ý chỉ theo `key`
  useEffect(() => {
    if (!entry || key === null || key === last.current) return;
    last.current = key;
    const headline = text(entry.alert, nameOf(entry.alert.subjectId)).headline;
    setMessage(entry.phase === "resolved" ? `${t("alerts.banner.resolved")}: ${headline}` : headline);
  }, [key]);
  return (
    <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
      {message}
    </div>
  );
}

function BannerBody({ entry, more }: { entry: BannerEntry; more: number }) {
  const t = useT();
  const text = useAlertText();
  const open = useOpenAlertTarget();
  const ack = useAckAlert();
  const setBanner = useAlertUiStore((s) => s.setBanner);
  const setBellOpen = useAlertUiStore((s) => s.setBellOpen);
  const a = entry.alert;
  const nameOf = useSubjectNames([a]);
  const msg = text(a, nameOf(a.subjectId));
  const resolved = entry.phase === "resolved";
  const tone = resolved ? "ok" : "danger";
  const actions = alertActions(a).slice(0, 2);

  return (
    <section
      aria-label={t("alerts.banner.region")}
      className={cn("flex gap-3 rounded-md border border-border border-l-4 px-4 py-3 shadow-sm transition-colors duration-200")}
      style={{ backgroundColor: `var(--${tone}-subtle)`, color: `var(--${tone}-fg)`, borderLeftColor: `var(--${tone})` }}
    >
      <SeverityIcon severity={a.severity} resolved={resolved} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <ProjectChip name={a.project.name} />
          {resolved && <span className="font-semibold text-sm">{t("alerts.banner.resolved")}</span>}
          <p className={cn("min-w-0 text-sm", resolved ? "truncate opacity-90" : "font-semibold")}>{msg.headline}</p>
        </div>
        {!resolved && (
          <>
            {msg.message && <p className="mt-1 text-sm">{msg.message}</p>}
            {msg.fix && <p className="mt-0.5 text-sm opacity-85">{msg.fix}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {actions.map((x, i) => (
                <Button
                  key={x.labelKey}
                  size="sm"
                  variant={i === 0 ? "default" : "outline"}
                  onClick={() => open(a.project.id, x.href)}
                >
                  {t(x.labelKey)}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="hover:bg-black/5 dark:hover:bg-white/10"
                style={{ color: "inherit" }}
                disabled={ack.isPending}
                onClick={() => {
                  setBanner((b) => bannerAck(b, a.id));
                  // Review L5: ack lỗi -> báo lỗi và trả banner về (không được im lặng mất cảnh báo critical).
                  ack.mutate(a.id, {
                    onError: (err) => {
                      toast.error(err instanceof Error ? err.message : String(err));
                      setBanner((b) => bannerAdd(b, a));
                    },
                  });
                }}
              >
                {t("alerts.banner.ack")}
              </Button>
              {more > 0 && (
                <button
                  type="button"
                  className="ml-auto text-sm underline underline-offset-2 hover:no-underline"
                  onClick={() => setBellOpen(true)}
                >
                  {t("alerts.banner.more", { count: more })}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
