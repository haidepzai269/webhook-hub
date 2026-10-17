/**
 * Token thiết kế của Event Flow — MỘT chỗ cho màu + icon (SPEC-event-flow-ui §0A.D).
 *
 * LUẬT ICON (Admin 10/10):
 *  - Mọi icon dùng Lucide (`lucide-react`). Không dùng icon mặc định của React Flow, không emoji,
 *    không dùng ký tự ✓/✗ làm icon.
 *  - Kích thước + nét đồng nhất: `ICON` (16px, nét 1.75) cho mọi chỗ; `ICON_SM` (13px) chỉ trong pill.
 *  - Provider/đích có thương hiệu (PayOS, SePay, GitHub, Stripe, Discord, Telegram, …) → LOGO THẬT dạng SVG inline
 *    (brand-logos.ts, đã làm sạch; provider-icon.tsx / destinationIcon). Không ảnh raster, không tải ảnh lúc chạy.
 *  - Màu trạng thái KHÔNG BAO GIỜ đứng một mình: luôn có icon + nhãn (người mù màu đọc được).
 */
import "./flow.css";
import { ICON, ICON_SM } from "@/components/admin/icon";

import type { ComponentType, CSSProperties } from "react";

import type { FlowNodeKind, Health, StageKey, StageStatus } from "@hub/flow";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Database,
  Flag,
  GitBranch,
  LoaderCircle,
  type LucideIcon,
  MessageSquare,
  Send,
  ShieldCheck,
  ShieldX,
  Shuffle,
  Store,
  Webhook,
} from "lucide-react";

import type { MessageKey } from "@/lib/i18n/dictionary";

import { brandIconComponent } from "./brand-logo";
import { brandLogo } from "./brand-logos";

/**
 * Khoá i18n cho nhãn chặng / trạng thái chặng / sức khoẻ — thay STAGE_LABELS, STAGE_STATUS_LABELS, HEALTH_LABELS
 * (chữ vi cố định của @hub/flow) ở UI: `t(stageLabelKey(stage.key))`.
 */
export const stageLabelKey = (key: StageKey) => `flow.stage.${key}` as MessageKey;
export const stageStatusKey = (status: StageStatus) => `journey.stage-status.${status.replace("_", "-")}` as MessageKey;
export const healthKey = (health: Health) => `flow.health.${health}` as MessageKey;

export { ICON, ICON_SM };

/** Tone = khoá màu chung cho canvas, pill, log, cạnh. */
export type Tone = "healthy" | "warning" | "crashed" | "idle" | "progress" | "skipped";

export const TONE_VAR: Record<Tone, string> = {
  healthy: "var(--flow-healthy)",
  warning: "var(--flow-warning)",
  crashed: "var(--flow-crashed)",
  idle: "var(--flow-idle)",
  progress: "var(--flow-progress)",
  skipped: "var(--flow-idle)",
};

export function toneStyle(tone: Tone): CSSProperties {
  return { "--tone": TONE_VAR[tone] } as CSSProperties;
}

export const STATUS_TONE: Record<StageStatus, Tone> = {
  ok: "healthy",
  failed: "crashed",
  warning: "warning",
  in_progress: "progress",
  pending: "idle",
  skipped: "skipped",
};

export const STATUS_ICON: Record<StageStatus, LucideIcon> = {
  ok: CircleCheck,
  failed: CircleX,
  warning: CircleAlert,
  in_progress: LoaderCircle,
  pending: Clock,
  skipped: Ban,
};

export const HEALTH_TONE: Record<Health, Tone> = {
  healthy: "healthy",
  warning: "warning",
  crashed: "crashed",
  idle: "idle",
};

export const HEALTH_ICON: Record<Health, LucideIcon> = {
  healthy: CircleCheck,
  warning: CircleAlert,
  crashed: CircleX,
  idle: CircleDashed,
};

export function stageIcon(key: StageKey, status: StageStatus): LucideIcon {
  switch (key) {
    case "received":
      return Webhook;
    case "verified":
      return status === "failed" ? ShieldX : ShieldCheck;
    case "persisted":
      return Database;
    case "normalized":
      return Shuffle;
    case "routed":
      return GitBranch;
    case "delivering":
      return Send;
    case "done":
      return Flag;
  }
}

/** Icon đích: cùng khuôn props với Lucide (`size`, `strokeWidth`) để nơi gọi không đổi. */
export type DestinationIcon = ComponentType<{ size?: number | string; strokeWidth?: number | string }>;

/** Component logo tạo MỘT lần ở cấp module (tạo trong render sẽ làm React remount mỗi lần vẽ). */
const DEST_BRAND: Record<string, DestinationIcon> = Object.fromEntries(
  ["discord", "telegram"].flatMap((id) => {
    const logo = brandLogo(id);
    return logo ? [[id, brandIconComponent(logo)]] : [];
  }),
);
const DEST_LUCIDE: Record<string, LucideIcon> = { discord: MessageSquare, telegram: Send };

export function destinationIcon(type: string): DestinationIcon {
  return DEST_BRAND[type] ?? DEST_LUCIDE[type] ?? Store;
}

export const KIND_ICON: Partial<Record<FlowNodeKind, LucideIcon>> = {
  gate: ShieldCheck,
  normalize: Shuffle,
  subscription: GitBranch,
};

/** Icon trạng thái có quay khi đang chạy. */
export function StatusGlyph({ status, small }: { status: StageStatus; small?: boolean }) {
  const Icon = STATUS_ICON[status];
  return <Icon {...(small ? ICON_SM : ICON)} className={status === "in_progress" ? "flow-spin" : undefined} aria-hidden />;
}

export function HealthGlyph({ health, small }: { health: Health; small?: boolean }) {
  const Icon = HEALTH_ICON[health];
  return <Icon {...(small ? ICON_SM : ICON)} aria-hidden />;
}
