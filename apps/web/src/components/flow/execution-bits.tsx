import { Fragment } from "react";

import type { ExecutionStatus, FlowFailedAt, FlowSummaryDot } from "@hub/flow";
import { STAGE_LABELS, STAGE_STATUS_LABELS } from "@hub/flow";
import { CircleAlert, CircleCheck, CircleX, LoaderCircle, ShieldX } from "lucide-react";

import { TonePill } from "./pills";
import { ICON_SM, STATUS_TONE, StatusGlyph, type Tone, TONE_VAR } from "./tokens";

export const EXECUTION_LABEL: Record<ExecutionStatus, string> = {
  succeeded: "Thành công",
  failed: "Thất bại",
  in_progress: "Đang chạy",
  rejected: "Bị từ chối",
};

export const EXECUTION_TONE: Record<ExecutionStatus, Tone> = {
  succeeded: "healthy",
  failed: "crashed",
  in_progress: "progress",
  rejected: "crashed",
};

const EXECUTION_ICON = { succeeded: CircleCheck, failed: CircleX, in_progress: LoaderCircle, rejected: ShieldX } as const;

export function ExecutionStatusPill({ status }: { status: ExecutionStatus }) {
  const Icon = EXECUTION_ICON[status];
  return (
    <TonePill tone={EXECUTION_TONE[status]} icon={<Icon {...ICON_SM} className={status === "in_progress" ? "flow-spin" : undefined} aria-hidden />}>
      {EXECUTION_LABEL[status]}
    </TonePill>
  );
}

/** "Đường ống mini" 6 chấm theo `summary` do server dựng — chấm giao gộp "2/3 đích". */
export function MiniPipeline({ summary }: { summary: FlowSummaryDot[] }) {
  return (
    <div className="flex items-center" aria-label="Đường ống">
      {summary.map((d, i) => {
        const tone = STATUS_TONE[d.status];
        const color = TONE_VAR[tone];
        return (
          <Fragment key={d.stage}>
            {i > 0 && <span className="h-px w-2.5" style={{ background: "var(--flow-card-border)" }} />}
            <span
              className="inline-flex items-center gap-1"
              title={`${STAGE_LABELS[d.stage]}: ${STAGE_STATUS_LABELS[d.status]}${d.total !== undefined ? ` (${d.okCount}/${d.total} đích)` : ""}`}
              style={{ color }}
            >
              <StatusGlyph status={d.status} small />
              {d.stage === "delivering" && d.total !== undefined && d.total > 0 && (
                <span className="font-medium text-[11px] tabular-nums">
                  {d.okCount}/{d.total}
                </span>
              )}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Cột "Hỏng ở": `Giao → Discord · HTTP 500 · lần 3/6`. */
export function failedAtText(f: FlowFailedAt | null): string | null {
  if (!f) return null;
  if (f.stage === "delivering") {
    const parts = [`Giao → ${f.destinationName ?? "?"}`];
    parts.push(f.httpStatus ? `HTTP ${f.httpStatus}` : f.reason.code);
    if (f.attemptNo) parts.push(`lần ${f.attemptNo}/${f.maxAttempts}`);
    return parts.join(" · ");
  }
  return `${STAGE_LABELS[f.stage]} · ${f.reason.code}`;
}

export function FailedAt({ failedAt, status }: { failedAt: FlowFailedAt | null; status: ExecutionStatus }) {
  const text = failedAtText(failedAt);
  if (!text) return <span className="text-muted-foreground text-xs">—</span>;
  const tone: Tone = status === "in_progress" ? "warning" : "crashed";
  const Icon = tone === "warning" ? CircleAlert : CircleX;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs" style={{ color: TONE_VAR[tone] }} title={failedAt?.reason.message}>
      <Icon {...ICON_SM} className="shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}
