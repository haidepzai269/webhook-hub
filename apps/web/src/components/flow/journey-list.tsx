"use client";

import type { FlowBranch, StageView } from "@hub/flow";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/use-t";

import { ACTION_ICON, ACTION_LABEL, type OnStageAction } from "./journey-canvas";
import { buildJourneyList, type JourneyStep } from "./journey-list-logic";
import { ProviderIcon } from "./provider-icon";
import { clock, countdown, fmtMs, useNow } from "./time";
import { destinationIcon, ICON, ICON_SM, STATUS_TONE, StatusGlyph, stageIcon, stageLabelKey, stageStatusKey, TONE_VAR, toneStyle } from "./tokens";

/** Một chặng: bấm / Enter mở panel chi tiết như node canvas; nút hành động bên trong tự xử lý (không nổi bọt). */
function StepCard({
  step,
  provider,
  branch,
  selectedId,
  onSelect,
  onAction,
  now,
}: {
  step: JourneyStep<StageView>;
  provider?: string;
  branch?: FlowBranch;
  selectedId: string | null;
  onSelect: (s: StageView, b?: FlowBranch) => void;
  onAction: OnStageAction;
  now: number;
}) {
  const t = useT();
  const { stage, deltaMs } = step;
  const tone = step.intentionalStop ? "idle" : STATUS_TONE[stage.status];
  const Icon = stageIcon(stage.key, stage.status);
  const color = TONE_VAR[tone];
  const nextAt = typeof stage.detail?.nextAttemptAt === "string" ? (stage.detail.nextAttemptAt as string) : null;
  const tier = typeof stage.detail?.tier === "string" ? (stage.detail.tier as string) : null;
  const due = t("journey.due");
  const cd = countdown(nextAt, now, due);
  const showTime = stage.key === "persisted" || stage.key === "received" || stage.key === "done";
  const open = () => onSelect(stage, branch);
  const DestIcon = stage.key === "done" && branch ? destinationIcon(branch.destination.type) : Icon;
  const leadIcon = stage.key === "received" && provider ? <ProviderIcon provider={provider} /> : <DestIcon {...ICON} />;
  return (
    // biome-ignore lint/a11y/useSemanticElements: thẻ chứa nút hành động con nên không thể là <button>
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={`flow-card relative cursor-pointer rounded-2xl px-3 py-2.5 ${selectedId === stage.id ? "is-selected" : ""}`}
      data-tone={tone}
      style={toneStyle(tone)}
    >
      <div className="flex items-center gap-2">
        <div className="flow-icon-box grid size-8 shrink-0 place-items-center rounded-lg" style={toneStyle(tone)}>
          {leadIcon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 font-medium text-[11px] uppercase tracking-wide" style={{ color }}>
            <StatusGlyph status={stage.status} small />
            <span>{t(stageLabelKey(stage.key))}</span>
            <span className="normal-case opacity-80">· {t(stageStatusKey(stage.status))}</span>
          </div>
        </div>
        {deltaMs !== null && deltaMs > 0 && (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums" style={{ color: "var(--flow-text-dim)" }}>
            +{fmtMs(deltaMs)}
          </span>
        )}
      </div>
      <div className="mt-1.5 break-words font-semibold text-[13px] leading-[1.3]">{stage.title}</div>
      {stage.subtitle && (
        <div className="mt-0.5 break-words text-[12px] leading-4" style={{ color: "var(--flow-text-dim)" }}>
          {stage.subtitle}
        </div>
      )}
      {showTime && stage.endedAt && (
        <div className="mt-0.5 font-mono text-[11.5px] tabular-nums" style={{ color: "var(--flow-text-dim)" }}>
          {t("journey.at", { time: clock(stage.endedAt) })}
        </div>
      )}
      {nextAt && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[12px] tabular-nums" style={{ color }}>
          <span className="font-semibold text-[14px]">{cd === due ? due : t("journey.remaining", { time: cd ?? "" })}</span>
          <span>
            {tier ? `${t("journey.tier", { tier })} · ` : ""}
            {t("journey.at", { time: clock(nextAt, false) })}
          </span>
        </div>
      )}
      {stage.reason && stage.status !== "ok" && (
        <div className="mt-1 break-words text-[12px] leading-4" style={{ color }}>
          {stage.reason.message}
        </div>
      )}
      {stage.actions && stage.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {stage.actions.map((a) => {
            const AI = ACTION_ICON[a];
            const primary = a === "replay_delivery" || a === "renormalize";
            return (
              // Cùng onAction với canvas → cùng đường xử lý (kể cả hộp xác nhận nếu có) — không đường tắt. Vùng chạm 40px.
              <Button
                key={a}
                type="button"
                variant={primary ? "replay" : "outline"}
                className="min-h-10 flex-1 basis-[8rem]"
                onClick={(e) => {
                  e.stopPropagation();
                  onAction(a, stage, branch);
                }}
              >
                <AI {...ICON_SM} aria-hidden />
                {t(ACTION_LABEL[a])}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Hành trình dạng danh sách dọc (dưới `md`): các chặng chính, rồi mỗi đích một nhóm (lần thử → kết thúc). */
export function JourneyList({
  stages,
  branches,
  provider,
  selectedId,
  onSelect,
  onAction,
}: {
  stages: StageView[];
  branches: FlowBranch[];
  provider?: string;
  selectedId: string | null;
  onSelect: (s: StageView, b?: FlowBranch) => void;
  onAction: OnStageAction;
}) {
  const t = useT();
  const now = useNow(1000);
  const list = buildJourneyList(stages, branches);
  return (
    <section className="space-y-3" aria-label={t("mobile.journey.aria")}>
      <ol className="space-y-2">
        {list.steps.map((s) => (
          <li key={s.stage.id}>
            <StepCard step={s} provider={provider} selectedId={selectedId} onSelect={onSelect} onAction={onAction} now={now} />
          </li>
        ))}
      </ol>
      {list.branches.map((b) => {
        const D = destinationIcon(b.branch.destination.type);
        return (
          <section key={b.branch.deliveryId} className="space-y-2 border-l-2 pl-3" style={{ borderColor: "var(--flow-card-border)" }}>
            <h3 className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-semibold text-[13px]">
              <D {...ICON} aria-hidden />
              <span className="min-w-0 break-words">{t("mobile.journey.branch", { name: b.branch.destination.name })}</span>
              <span className="font-normal text-[11.5px]" style={{ color: "var(--flow-text-dim)" }}>
                {b.branch.subscription.name} · {t("journey.generation", { n: b.branch.generation })} · {t("mobile.journey.attempts", { count: b.attempts })}
              </span>
            </h3>
            <ol className="space-y-2">
              {b.steps.map((s) => (
                <li key={s.stage.id}>
                  <StepCard step={s} branch={b.branch} selectedId={selectedId} onSelect={onSelect} onAction={onAction} now={now} />
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </section>
  );
}
