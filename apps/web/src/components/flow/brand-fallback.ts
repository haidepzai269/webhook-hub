/**
 * Ô chữ tắt cho nguồn KHÔNG có logo (GenericAdapter `generic`/`api`, chuỗi provider lạ) — để hai nguồn khác nhau không
 * cùng một icon chung. Logic chép từ ProjectAvatar ở app/(admin)/projects/_components/projects-home.tsx (hàm ở đó không
 * export và file đó thuộc việc khác) — đổi một bên thì đổi cả hai để màu/chữ tắt nhất quán.
 *
 * Không bao giờ tải favicon/logo từ domain của provider lúc chạy (ADR-236): chữ tắt + màu tính tại chỗ.
 */

import { type BrandLogo, brandLogo } from "./brand-logos";

/** Hue ổn định theo chuỗi (cùng chuỗi -> cùng màu) — chỉ để nhận diện bằng mắt, không mang nghĩa. */
export function hueOf(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** 1–2 ký tự đầu: hai từ -> chữ đầu mỗi từ; một từ -> hai ký tự đầu. Viết hoa. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const s = words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

/** Nền gradient cùng công thức với ProjectAvatar. */
export function avatarBackground(key: string): string {
  const h = hueOf(key);
  return `linear-gradient(135deg, oklch(0.68 0.15 ${h}), oklch(0.52 0.17 ${(h + 40) % 360}))`;
}

/** Quyết định icon của nguồn — tách khỏi provider-icon.tsx để test được (jest không nạp .tsx). */
export type ProviderIconPlan =
  | { kind: "logo"; logo: BrandLogo }
  | { kind: "initials"; name: string; text: string; background: string }
  | { kind: "generic" };

export function planProviderIcon(provider: string, name?: string | null): ProviderIconPlan {
  const logo = brandLogo(provider);
  if (logo) return { kind: "logo", logo };
  const n = name?.trim();
  if (n) return { kind: "initials", name: n, text: initials(n), background: avatarBackground(n) };
  return { kind: "generic" };
}
