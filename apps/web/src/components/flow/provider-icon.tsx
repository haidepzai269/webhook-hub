import type { LucideIcon } from "lucide-react";
import { PlugZap, Puzzle, Webhook } from "lucide-react";

import { planProviderIcon } from "./brand-fallback";
import { BrandLogo } from "./brand-logo";
import { ICON } from "./tokens";

/**
 * Icon của nguồn (ADR-236 — logo thương hiệu thật):
 *  1. Có logo thật (brand-logos.ts: Simple Icons CC0 / logo chính thức đã làm sạch) -> vẽ logo.
 *  2. Không có logo + có `name` (tên source) -> ô chữ tắt, màu ổn định theo tên (brand-fallback.ts).
 *  3. Còn lại -> icon Lucide chung như trước (api: PlugZap, generic: Puzzle, lạ: Webhook).
 * Không bao giờ tải favicon/logo từ domain provider lúc chạy.
 */
/** Nguồn của đợt đa service (SPEC §6A): `api` (service tự publish) và `generic` — có sẵn trong Lucide. */
const LUCIDE_PROVIDERS: Record<string, LucideIcon> = { api: PlugZap, generic: Puzzle };

export function ProviderIcon({ provider, size = ICON.size, name }: { provider: string; size?: number; name?: string }) {
  const plan = planProviderIcon(provider, name);
  if (plan.kind === "logo") return <BrandLogo logo={plan.logo} size={size} />;
  if (plan.kind === "initials")
    return (
      <span
        role="img"
        aria-label={plan.name}
        title={plan.name}
        className="inline-flex shrink-0 items-center justify-center rounded-[4px] font-semibold text-white leading-none"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(7, Math.round(size * 0.5)),
          background: plan.background,
        }}
      >
        {plan.text}
      </span>
    );
  const Fallback: LucideIcon = LUCIDE_PROVIDERS[provider] ?? Webhook;
  return <Fallback size={size} strokeWidth={ICON.strokeWidth} aria-hidden />;
}
