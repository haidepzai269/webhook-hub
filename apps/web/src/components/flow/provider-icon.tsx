import type { LucideIcon } from "lucide-react";
import { PlugZap, Puzzle, Webhook } from "lucide-react";

import { ICON } from "./tokens";

/**
 * Glyph provider dạng SVG inline, CÙNG hệ với Lucide: viewBox 24, stroke currentColor, nét 1.75,
 * bo tròn. Không phải logo thương hiệu chính thức — chỉ là ký hiệu gọn để nhận ra nhanh trên canvas.
 */
function Svg({ children, size = ICON.size }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const GLYPHS: Record<string, (p: { size?: number }) => React.ReactElement> = {
  // PayOS: thẻ thanh toán + chữ P
  payos: ({ size }) => (
    <Svg size={size}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M8 15.5V8.5h3a2 2 0 0 1 0 4H8" />
      <path d="M15 15.5h3" />
    </Svg>
  ),
  // SePay: ngân hàng (biến động số dư)
  sepay: ({ size }) => (
    <Svg size={size}>
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M5 10v7M9.5 10v7M14.5 10v7M19 10v7" />
      <path d="M3 20h18" />
    </Svg>
  ),
  // GitHub: octocat giản lược (mèo + nhánh)
  github: ({ size }) => (
    <Svg size={size}>
      <path d="M9 19c-4 1.3-4-2-6-2.5" />
      <path d="M15 21v-3.2a2.8 2.8 0 0 0-.8-2.2c2.7-.3 5.5-1.3 5.5-6a4.7 4.7 0 0 0-1.3-3.2 4.4 4.4 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.5 2.9 5.5 3.2 5.5 3.2a4.4 4.4 0 0 0-.1 3.2A4.7 4.7 0 0 0 4.1 9.6c0 4.7 2.8 5.7 5.5 6a2.8 2.8 0 0 0-.8 2.2V21" />
    </Svg>
  ),
  // Stripe: chữ S trong ô
  stripe: ({ size }) => (
    <Svg size={size}>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M15 9.2c-.6-.8-1.7-1.2-3-1.2-1.7 0-2.8.8-2.8 2 0 2.8 6 1.6 6 4.3 0 1.3-1.2 2.2-3.1 2.2-1.4 0-2.6-.5-3.3-1.4" />
    </Svg>
  ),
};

/** Nguồn của đợt đa service (SPEC §6A): `api` (service tự publish) và `generic` — có sẵn trong Lucide. */
const LUCIDE_PROVIDERS: Record<string, LucideIcon> = { api: PlugZap, generic: Puzzle };

export function ProviderIcon({ provider, size }: { provider: string; size?: number }) {
  const G = GLYPHS[provider];
  if (G) return <G size={size} />;
  const Fallback: LucideIcon = LUCIDE_PROVIDERS[provider] ?? Webhook;
  return <Fallback size={size ?? ICON.size} strokeWidth={ICON.strokeWidth} aria-hidden />;
}
