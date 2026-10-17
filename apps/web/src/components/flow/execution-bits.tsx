"use client";

import { Fragment } from "react";

import type { ExecutionStatus, FlowFailedAt, FlowSummaryDot } from "@hub/flow";
import { CircleAlert, CircleCheck, CircleX, Info, LoaderCircle, ShieldX } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CellTooltip } from "@/components/ui/cell-tooltip";
import type { MessageKey, TranslateFn } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

import { expectedProbe, type ProbeInfo, stageHint } from "./event-notes";
import { TonePill } from "./pills";
import { ICON_SM, STATUS_TONE, StatusGlyph, stageLabelKey, stageStatusKey, type Tone, TONE_VAR } from "./tokens";

/** Khoá nhãn kết quả một hành trình — `t(EXECUTION_LABEL_KEY[status])`. */
export const EXECUTION_LABEL_KEY: Record<ExecutionStatus, MessageKey> = {
  succeeded: "journey.exec.succeeded",
  failed: "journey.exec.failed",
  in_progress: "journey.exec.in-progress",
  rejected: "journey.exec.rejected",
};

export const EXECUTION_TONE: Record<ExecutionStatus, Tone> = {
  succeeded: "healthy",
  failed: "crashed",
  in_progress: "progress",
  rejected: "crashed",
};

/** Hover chấm chặng: hiện nhanh nhưng không bật khi chuột chỉ lướt qua hàng. */
const TOOLTIP_DELAY_MS = 150;

const EXECUTION_ICON = { succeeded: CircleCheck, failed: CircleX, in_progress: LoaderCircle, rejected: ShieldX } as const;

/** `probe` (từ `expectedProbe`): request kiểm tra kết nối đúng thiết kế → pill trung tính, không "Thành công" xanh. */
export function ExecutionStatusPill({ status, probe }: { status: ExecutionStatus; probe?: ProbeInfo | null }) {
  const t = useT();
  if (probe) {
    return (
      <TonePill tone="idle" icon={<Info {...ICON_SM} aria-hidden />}>
        {t(probe.label)}
      </TonePill>
    );
  }
  const Icon = EXECUTION_ICON[status];
  return (
    <TonePill tone={EXECUTION_TONE[status]} icon={<Icon {...ICON_SM} className={status === "in_progress" ? "flow-spin" : undefined} aria-hidden />}>
      {t(EXECUTION_LABEL_KEY[status])}
    </TonePill>
  );
}

/** Ngữ cảnh tuỳ chọn cho tooltip chấm: có thì thêm một dòng lý do (vd chấm Normalize của request kiểm tra kết nối). */
export interface PipelineContext {
  provider: string;
  type: string | null;
  failedAt: FlowFailedAt | null;
  /** events.probe từ server (ADR-159/163) — expectedProbe tin cờ này trước phỏng đoán. */
  probe?: boolean;
}

/**
 * "Đường ống mini" 6 chấm theo `summary` do server dựng — chấm giao gộp "2/3 đích".
 * Hover một chấm → tooltip gọn kiểu trang Hành trình: tên chặng · trạng thái · (ok/tổng đích) · lý do một dòng.
 * Trigger là <span> (asChild), không phải <button>: hàng là <Link>, bấm lên chấm vẫn mở hàng như thường.
 * Dùng TooltipProvider gốc (layout admin); độ trễ đặt trên từng <Tooltip>.
 * `decorative`: hàng đã có câu mô tả (cột Ghi chú) → ẩn chấm khỏi trình đọc màn hình để tên link không dài lê thê.
 */
export function MiniPipeline({
  summary,
  context,
  decorative,
}: {
  summary: FlowSummaryDot[];
  context?: PipelineContext;
  decorative?: boolean;
}) {
  const t = useT();
  const probe = context ? expectedProbe({ ...context, summary }) : null;
  return (
    <div className="flex items-center" aria-hidden={decorative ? true : undefined}>
      {summary.map((d, i) => {
        // Probe đúng thiết kế (ADR-159): chấm "!" ở Normalize vẽ trung tính (icon Info + nhãn probe), không vàng.
        const asProbe = probe !== null && d.stage === "normalized" && d.status === "warning";
        const color = asProbe ? TONE_VAR.idle : TONE_VAR[STATUS_TONE[d.status]];
        const statusLabel = asProbe ? t(probe.label) : t(stageStatusKey(d.status));
        const dests = d.stage === "delivering" && d.total !== undefined && d.total > 0 ? `${d.okCount}/${d.total}` : null;
        const hint = context ? stageHint({ ...context, summary }, d, t) : null;
        const stageLabel = t(stageLabelKey(d.stage));
        const destsText = dests ? t("journey.pipeline.dests", { dests }) : null;
        return (
          <Fragment key={d.stage}>
            {i > 0 && <span className="h-px w-2.5" style={{ background: "var(--flow-card-border)" }} />}
            <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1" style={{ color }}>
                  {asProbe ? <Info {...ICON_SM} aria-hidden /> : <StatusGlyph status={d.status} small />}
                  {!decorative && <span className="sr-only">{`${stageLabel}: ${statusLabel}${destsText ? ` (${destsText})` : ""}`}</span>}
                  {dests && (
                    <span className="font-medium text-2xs tabular-nums" aria-hidden>
                      {dests}
                    </span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="font-sans">
                <span className="flex flex-col gap-0.5">
                  <span>
                    <span className="font-medium">{stageLabel}</span>
                    <span className="opacity-80">
                      {" · "}
                      {statusLabel}
                      {destsText && ` · ${destsText}`}
                    </span>
                  </span>
                  {hint && <span className="line-clamp-2 opacity-80">{hint}</span>}
                </span>
              </TooltipContent>
            </Tooltip>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Cột "Hỏng ở": `Giao → Discord · HTTP 500 · lần 3/6`. */
export function failedAtText(f: FlowFailedAt | null, t: TranslateFn): string | null {
  if (!f) return null;
  if (f.stage === "delivering") {
    const parts = [t("journey.failed.deliver", { dest: f.destinationName ?? "?" })];
    parts.push(f.httpStatus ? `HTTP ${f.httpStatus}` : f.reason.code);
    if (f.attemptNo) parts.push(t("journey.failed.attempt", { n: f.attemptNo, max: f.maxAttempts ?? "?" }));
    return parts.join(" · ");
  }
  return `${t(stageLabelKey(f.stage))} · ${f.reason.code}`;
}

export function FailedAt({ failedAt, status }: { failedAt: FlowFailedAt | null; status: ExecutionStatus }) {
  const t = useT();
  const text = failedAtText(failedAt, t);
  if (!text) return <span className="text-muted-foreground text-xs">—</span>;
  const tone: Tone = status === "in_progress" ? "warning" : "crashed";
  const Icon = tone === "warning" ? CircleAlert : CircleX;
  return (
    // reason.message là thông tin THÊM (không phải chữ bị cắt) → luôn hiện; thiếu thì chỉ hiện khi `text` bị truncate.
    <CellTooltip text={failedAt?.reason.message || text} always={Boolean(failedAt?.reason.message)}>
      <span className="inline-flex min-w-0 items-center gap-1 text-xs" style={{ color: TONE_VAR[tone] }}>
        <Icon {...ICON_SM} className="shrink-0" aria-hidden />
        <span data-cell-text className="truncate">{text}</span>
      </span>
    </CellTooltip>
  );
}
