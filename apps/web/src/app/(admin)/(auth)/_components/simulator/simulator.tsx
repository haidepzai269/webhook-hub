"use client";

import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import type { FlowBranch, StageKey, StageStatus, StageView } from "@hub/flow";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";

import { JourneyCanvas } from "@/components/flow/journey-canvas";
import { useLocale } from "@/lib/i18n/use-t";

import styles from "./simulator.module.css";
import {
  type Component,
  type Frame,
  JOURNEY_TITLES,
  type JourneyStage,
  type Lang,
  SCENARIOS,
  type Scenario,
  type ScenarioId,
  stepById,
  UI,
} from "./steps";

/**
 * Mô phỏng một webhook PayOS → hub → shop theo đúng `steps.ts` (trích từ code thật), vẽ bằng CHÍNH màn Hành trình
 * của dashboard (`JourneyCanvas`, @xyflow/react) với StageView dựng tại client. THUẦN CLIENT: không fetch, không
 * react-query, không socket; onSelect/onAction là no-op. Module (kể cả xyflow + CSS) chỉ được `import()` khi bấm nút.
 * Mỗi khung ~900ms; giảm chuyển động → không tự chạy, chỉ "Tiếp".
 */

const STEP_MS = 900;
const COMPONENTS: readonly Component[] = [
  "provider",
  "hub-api",
  "postgres",
  "redis",
  "rabbitmq",
  "hub-worker",
  "service",
];
const MAIN: readonly (JourneyStage & StageKey)[] = ["received", "verified", "persisted", "normalized", "routed"];
const D = "sim"; // deliveryId giả
const noop = () => undefined;

/**
 * JourneyCanvas chỉ `fitView` lúc khởi tạo — mà lúc đó panel còn đang phóng to (transition grid). Bọc chung một
 * ReactFlowProvider rồi fit lại mỗi khi khung canvas đổi kích thước (ResizeObserver; không timer, không mạng).
 */
function FitOnResize({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const ro = new ResizeObserver(() => void fitView({ padding: 0.05, maxZoom: 1, minZoom: 0.6 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView, target]);
  return null;
}

function useReducedMotion(): boolean {
  const [reduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  return reduced;
}

function view(
  id: string,
  key: StageKey,
  status: StageStatus,
  title: string,
  subtitle?: string,
  detail?: Record<string, unknown>,
): StageView {
  // Không có thời gian/độ trễ giả: offsetMs/endedAt = null → canvas không vẽ nhãn "+ms".
  return { id, key, status, startedAt: null, endedAt: null, durationMs: null, offsetMs: null, title, subtitle, detail };
}

const reachedIn = (frames: readonly Frame[], idx: number, stage: JourneyStage) =>
  frames.slice(0, idx + 1).filter((f) => stepById(f.id).journey === stage);

/** Trạng thái một chặng tại khung `idx`: chưa tới / đang chạy / xong / lỗi / dừng có chủ đích / bị bỏ qua. */
function statusOf(frames: readonly Frame[], idx: number, stage: JourneyStage, finished: boolean): StageStatus {
  const reached = reachedIn(frames, idx, stage);
  if (reached.length === 0) return finished ? "skipped" : "pending";
  const lastF = reached[reached.length - 1];
  if (lastF.tone === "fail") return "failed";
  if (lastF.tone === "warn") return "warning";
  if (stepById(frames[idx].id).journey === stage && !finished) return "in_progress";
  return "ok";
}

function subtitleOf(frames: readonly Frame[], idx: number, stage: JourneyStage, lang: Lang): string | undefined {
  const reached = reachedIn(frames, idx, stage);
  const f = reached[reached.length - 1];
  if (!f) return undefined;
  return f.note ? f.note[lang] : stepById(f.id).label[lang];
}

/** Dựng StageView[] + một FlowBranch (shop) cho JourneyCanvas từ kịch bản tại khung `idx`. */
function buildJourney(sc: Scenario, idx: number, lang: Lang) {
  const frames = sc.frames;
  const finished = idx === frames.length - 1;
  const stages = MAIN.map((k) =>
    view(
      k,
      k,
      statusOf(frames, idx, k, finished),
      (sc.titles?.[k] ?? JOURNEY_TITLES[k])[lang],
      subtitleOf(frames, idx, k, lang),
    ),
  );

  // Các lần gửi: sign-send mở một lần thử; service-verify chốt 200/503; retry-tier (attempt = n) là lần n đã 503.
  const attempts: { status: StageStatus; http: number | null }[] = [];
  frames.slice(0, idx + 1).forEach((f, i) => {
    const current = i === idx;
    if (f.id === "sign-send") attempts.push({ status: "in_progress", http: null });
    if (f.id === "service-verify") {
      if (!attempts.length) attempts.push({ status: "in_progress", http: null });
      const a = attempts[attempts.length - 1];
      if (f.tone === "fail") Object.assign(a, { status: "failed", http: 503 });
      else if (!current) Object.assign(a, { status: "ok", http: 200 });
    }
    if (f.attempt && attempts.length < f.attempt) attempts.push({ status: "failed", http: 503 });
  });
  const deliveringStatus = statusOf(frames, idx, "delivering", finished);
  const doneStatus = statusOf(frames, idx, "done", finished);
  const queuedStatus: StageStatus = attempts.length || deliveringStatus === "failed" ? "ok" : deliveringStatus;
  const doneTitle =
    doneStatus === "pending" || doneStatus === "skipped" ? JOURNEY_TITLES.done[lang] : sc.outcome.text[lang];
  const branchStages: StageView[] = [
    view(`${D}:queued`, "delivering", queuedStatus, JOURNEY_TITLES.delivering[lang], undefined, {
      circuitState: "CLOSED",
    }),
    ...attempts.map((a, i) =>
      view(`${D}:attempt:${i + 1}`, "delivering", a.status, `#${i + 1}`, undefined, {
        httpStatus: a.http,
        attemptNo: i + 1,
      }),
    ),
    view(`${D}:done`, "done", doneStatus, doneTitle, subtitleOf(frames, idx, "done", lang)),
  ];
  const branches: FlowBranch[] = [
    {
      deliveryId: D,
      subscription: { id: "sub", name: "payment.received", eventTypes: ["payment.received"] },
      destination: { id: "shop", name: "shop", type: "webhook" },
      generation: 1,
      status: doneStatus,
      stages: branchStages,
      history: [],
    },
  ];

  // Node "được chọn" = chặng của bước hiện tại (viền nổi bật trên canvas).
  const j = stepById(frames[idx].id).journey;
  let selectedId: string = j;
  if (j === "delivering") selectedId = attempts.length ? `${D}:attempt:${attempts.length}` : `${D}:queued`;
  if (j === "done") selectedId = `${D}:done`;
  return { stages, branches, selectedId };
}

export function Simulator({ onExit }: { onExit: () => void }) {
  const locale = useLocale();
  const lang: Lang = locale === "en" ? "en" : "vi";
  const reduced = useReducedMotion();
  const [scenarioId, setScenarioId] = useState<ScenarioId>("ok");
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(!reduced);
  const firstControl = useRef<HTMLButtonElement>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];
  const frame = scenario.frames[idx];
  const step = stepById(frame.id);
  const done = idx === scenario.frames.length - 1;
  const journey = useMemo(() => buildJourney(scenario, idx, lang), [scenario, idx, lang]);

  // Một timer duy nhất, chỉ khi đang chạy; dừng ở khung cuối (không vòng lặp nền).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idx`/`scenarioId` là nhịp — mỗi khung đặt lại đúng một timer.
  useEffect(() => {
    if (!playing || done) return;
    const id = setTimeout(() => setIdx((i) => i + 1), STEP_MS);
    return () => clearTimeout(id);
  }, [playing, done, idx, scenarioId]);

  // Tới khung cuối: dừng, và đưa focus sang "Chạy lại" (hoặc nút thoát khi giảm chuyển động) — "Tiếp" vừa bị
  // disabled, không để focus rơi về <body>.
  useEffect(() => {
    if (!done) return;
    setPlaying(false);
    (playRef.current ?? exitRef.current)?.focus();
  }, [done]);

  // Mở → focus vào điều khiển đầu tiên; Esc ở bất kỳ đâu → thoát (AuthShell trả focus về nút ban đầu).
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  useEffect(() => {
    firstControl.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !e.defaultPrevented) onExitRef.current();
    };
    document.addEventListener("keydown", onKey);
    // Màn hẹp (<900px) không có chỗ cho chế độ toàn màn hình (panel đã thu thành dải) → tự thoát về form.
    const narrow = window.matchMedia("(max-width: 899.98px)");
    const onNarrow = () => narrow.matches && onExitRef.current();
    onNarrow();
    narrow.addEventListener("change", onNarrow);
    return () => {
      document.removeEventListener("keydown", onKey);
      narrow.removeEventListener("change", onNarrow);
    };
  }, []);

  const choose = (id: ScenarioId) => {
    setScenarioId(id);
    setIdx(0);
    setPlaying(!reduced);
  };
  const togglePlay = () => {
    if (done) {
      setIdx(0);
      setPlaying(!reduced);
      return;
    }
    setPlaying((p) => !p);
  };
  const next = () => {
    setPlaying(false);
    if (!done) setIdx((i) => i + 1);
  };

  const fail = frame.tone === "fail";
  const ref = `${step.source.file}#${step.source.symbol}`;
  const label = `${step.label[lang]}${frame.note ? ` — ${frame.note[lang]}` : ""}`;
  // Vùng đọc cho trình đọc màn hình: chỉ số bước + nhãn (không đọc mô tả dài mỗi 900ms); khung cuối đọc kết quả.
  const live = `${UI.step[lang]} ${idx + 1}/${scenario.frames.length}: ${label}${done ? `. ${UI.result[lang]}: ${scenario.outcome.text[lang]}` : ""}`;
  let playLabel = UI.play[lang];
  if (done) playLabel = UI.replay[lang];
  else if (playing) playLabel = UI.pause[lang];

  return (
    <section className={styles.panel} aria-label={UI.region[lang]}>
      <div className={styles.toolbar}>
        <fieldset className={styles.scenarios}>
          <legend className={styles.srOnly}>{UI.scenario[lang]}</legend>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={styles.chipBtn}
              aria-pressed={s.id === scenarioId}
              onClick={() => choose(s.id)}
            >
              {s.label[lang]}
            </button>
          ))}
        </fieldset>
        <div className={styles.controls}>
          {!reduced && (
            <button
              ref={(el) => {
                firstControl.current = el;
                playRef.current = el;
              }}
              type="button"
              className={styles.ctrl}
              onClick={togglePlay}
            >
              <span aria-hidden="true">{playing ? "⏸" : "▷"}</span>
              <span className={styles.srOnly}>{playLabel}</span>
            </button>
          )}
          <button
            ref={reduced ? firstControl : undefined}
            type="button"
            className={styles.ctrl}
            onClick={next}
            disabled={done}
          >
            {UI.next[lang]} <span aria-hidden="true">▸</span>
          </button>
          <button ref={exitRef} type="button" className={styles.ctrl} onClick={onExit} aria-label={UI.exit[lang]}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </div>

      {/* Canvas thật của màn Hành trình, giữ tối như panel (class `dark` chỉ phủ vùng này). Trang trí → aria-hidden +
          inert (node canvas có role=button); thanh chú thích bên dưới mới là nội dung đọc được. */}
      <div ref={canvasRef} className={`dark flow-canvas ${styles.canvas}`} aria-hidden="true" inert>
        <ReactFlowProvider>
          <FitOnResize target={canvasRef} />
          <JourneyCanvas
            stages={journey.stages}
            branches={journey.branches}
            provider="payos"
            selectedId={journey.selectedId}
            onSelect={noop}
            onAction={noop}
          />
        </ReactFlowProvider>
      </div>

      <p className={styles.srOnly} aria-live="polite">
        {live}
      </p>
      <div className={styles.caption}>
        <p className={styles.head}>
          <span className={styles.count}>
            {UI.step[lang]} {idx + 1}/{scenario.frames.length}
          </span>{" "}
          <span className={styles.label} data-fail={fail || undefined}>
            {label}
          </span>
        </p>
        <p className={styles.detail}>{(frame.detail ?? step.detail)[lang]}</p>
        {done && (
          <p className={styles.outcome} data-fail={scenario.outcome.tone === "fail" || undefined}>
            {UI.result[lang]}: <strong>{scenario.outcome.text[lang]}</strong>
            {scenario.outcome.note && <span className={styles.outcomeNote}>{scenario.outcome.note[lang]}</span>}
          </p>
        )}
      </div>
      <div className={styles.meta}>
        <p className={styles.ref} title={ref}>
          {ref}
        </p>
        <ul className={styles.components} aria-hidden="true">
          {COMPONENTS.map((c) => (
            <li key={c} data-on={c === step.component || undefined}>
              {c}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
