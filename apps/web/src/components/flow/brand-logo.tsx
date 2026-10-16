import type { CSSProperties } from "react";

import type { BrandLogo as BrandLogoData } from "./brand-logos";
import { monoFill } from "./brand-logos";

/**
 * Vẽ logo thương hiệu từ dữ liệu đã làm sạch (brand-logos.ts) — SVG inline, không ảnh, không gọi mạng.
 * Logo đơn sắc: tô màu thương hiệu, tự chuyển sang màu chữ của theme khi tương phản < 2:1 (GitHub đen -> trắng ở dark).
 * Logo nhiều màu: giữ fill gốc từng path.
 * Không import ./tokens (tokens.tsx import file này cho destinationIcon).
 */
export function BrandLogo({ logo, size = 16 }: { logo: BrandLogoData; size?: number | string }) {
  const mono = logo.hex ? monoFill(logo.hex) : null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={logo.viewBox}
      role="img"
      aria-label={logo.title}
      className={mono ? "shrink-0 fill-(--brand-light) dark:fill-(--brand-dark)" : "shrink-0"}
      style={mono ? ({ "--brand-light": mono.light, "--brand-dark": mono.dark } as CSSProperties) : undefined}
    >
      {logo.paths.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: danh sách path tĩnh, không đổi thứ tự
        <path key={i} d={p.d} fill={p.fill} fillRule={p.fillRule} transform={p.transform} />
      ))}
    </svg>
  );
}

/** Component cùng khuôn props với icon Lucide (size, strokeWidth bỏ qua) — dùng làm icon đích. */
export function brandIconComponent(logo: BrandLogoData) {
  function BrandIcon({ size }: { size?: number | string; strokeWidth?: number | string }) {
    return <BrandLogo logo={logo} size={size} />;
  }
  BrandIcon.displayName = `BrandIcon(${logo.title})`;
  return BrandIcon;
}
