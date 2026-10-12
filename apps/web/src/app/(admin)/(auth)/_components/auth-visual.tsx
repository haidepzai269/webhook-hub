"use client";

import { Component, type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";

import { useT } from "@/lib/i18n/use-t";

import styles from "./auth.module.css";

/**
 * Panel minh hoạ "Đăng nhập là một sự kiện" — kể bản chất hub bằng hình: 3 provider → hub (thứ tự ingest CỐ ĐỊNH
 * `verify → commit → 2xx`, ARCHITECTURE §3.1 / BB-3) → service; ba luồng song song, lệch pha 1/3 chu kỳ.
 * Toàn bộ là dữ liệu TĨNH, không phải số đo.
 * SVG + log là trang trí (aria-hidden); riêng nút "Mô phỏng một webhook" là điều khiển thật nên <aside> KHÔNG aria-hidden.
 * Chuyển động chỉ chạy khi `prefers-reduced-motion: no-preference`.
 *
 * Mô phỏng (simulator/) chỉ được `import()` khi bấm nút: bundle ban đầu chỉ thêm nút, không timer/rAF nào trước đó.
 */

type SimulatorProps = { onExit: () => void };

/** Lỗi render trong mô phỏng không được làm sập trang đăng nhập: báo lên rồi quay về sơ đồ. */
class SimBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Hình học (viewBox 0 0 480 280): chip trái kết thúc ở x=92, hub chiếm x∈[165,315], chip phải bắt đầu ở x=388; tâm hub y=140.
const inWire = (y: number) => `M92,${y} C130,${y} 130,140 165,140`;
const outWire = (y: number) => `M315,140 C353,140 353,${y} 388,${y}`;
// Đường gói tin của một luồng: provider → hub (khuất sau khối hub = đang xử lý) → service.
const packetPath = (y: number) => `${inWire(y)} L315,140 C353,140 353,${y} 388,${y}`;

// Định danh kỹ thuật, CỐ Ý để literal (không i18n): dòng log (verb HTTP, tên bảng, mã trạng thái), nhãn SVG
// "hub · ingest", bước verify/commit/2xx, thẻ HMAC/PG/ack, tên provider/service — giống nhau ở mọi ngôn ngữ.

/** Ba luồng chạy song song, cùng đi qua MỘT hub: provider → verify → commit → 2xx → service. `flow` = sắc độ (CSS). */
const FLOWS = [
  { flow: 0, provider: "PayOS", service: "shop", y: 50 },
  { flow: 1, provider: "GitHub", service: "cafe", y: 140 },
  { flow: 2, provider: "Stripe", service: "bookstore", y: 230 },
] as const;

// [flow tô màu verb (null = trung tính), verb, đích, ghi chú] — 5 dòng, phủ đủ ba luồng.
const LOG_LINES: ReadonlyArray<readonly [number | null, string, string, string]> = [
  [0, "POST", "/hooks/payos", "sig ✓ timingSafeEqual"],
  [null, "INSERT", "raw_events … COMMIT", "← 200 OK"],
  [1, "POST", "/hooks/github", "sig ✓ · COMMIT · 200"],
  [2, "POST", "/hooks/stripe", "sig ✓ · COMMIT · 200"],
  [null, "→", "shop · cafe · bookstore", "delivered"],
];

const STAGES = [
  { label: "verify", tag: "HMAC", y: 128 },
  { label: "commit", tag: "PG", y: 152 },
  { label: "2xx", tag: "ack", y: 176 },
] as const;

/**
 * `onSimChange`: báo AuthShell để thu form (inert, giữ nguyên state react-hook-form) và phóng panel toàn màn hình.
 */
export function AuthVisual({ onSimChange }: { onSimChange?: (open: boolean) => void }) {
  const t = useT();
  const [Sim, setSim] = useState<ComponentType<SimulatorProps> | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  const open = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const mod = await import("./simulator/simulator");
      setSim(() => mod.Simulator);
    } catch {
      // Chunk tải hỏng (mạng chập chờn, bản deploy mới đổi tên chunk…) → báo ngắn, trang đăng nhập vẫn dùng được.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const exit = () => {
    returnFocus.current = true;
    setSim(null);
  };
  const crash = () => {
    setFailed(true);
    exit();
  };
  // Báo trạng thái lên AuthShell; thoát → focus về lại nút ban đầu (không để focus rơi về <body>).
  useEffect(() => {
    onSimChange?.(Boolean(Sim));
    if (!Sim && returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [Sim, onSimChange]);

  if (Sim) {
    return (
      <aside className={styles.visual} aria-label={t("auth.visual.aria")} data-sim="on">
        <div className={styles.simTop}>
          <div className={styles.brand}>
            <span className={styles.brandMark} />
            {t("auth.visual.brand")}
          </div>
          <button type="button" className={styles.simTrigger} onClick={exit}>
            <span aria-hidden="true">←</span> {t("auth.sim.back")}
          </button>
        </div>
        <SimBoundary onError={crash}>
          <Sim onExit={exit} />
        </SimBoundary>
      </aside>
    );
  }

  return (
    <aside className={styles.visual} aria-label={t("auth.visual.aria")}>
      <div className={styles.brand}>
        <span className={styles.brandMark} />
        {t("auth.visual.brand")}
      </div>

      <div className={styles.visualBody}>
        <p className={styles.eyebrow}>{t("auth.visual.eyebrow")}</p>
        <svg className={styles.diagram} viewBox="0 0 480 280" aria-hidden="true" focusable="false">
          {FLOWS.map((f) => (
            <g key={f.provider} data-flow={f.flow}>
              <path d={inWire(f.y)} className={styles.wireLit} />
              <path d={outWire(f.y)} className={styles.wireLit} />
              <path d={packetPath(f.y)} pathLength={100} className={styles.packet} />
            </g>
          ))}

          {FLOWS.map((f) => (
            <g key={f.provider} data-flow={f.flow} className={`${styles.chip} ${styles.chipSource}`}>
              <rect x={8} y={f.y - 14} width={84} height={28} rx={6} />
              <text x={50} y={f.y + 4} textAnchor="middle">
                {f.provider}
              </text>
            </g>
          ))}

          <g className={styles.hub}>
            <rect x={165} y={80} width={150} height={120} rx={10} />
            <text x={179} y={102} className={styles.hubLabel}>
              hub · ingest
            </text>
            <line x1={182} y1={128} x2={182} y2={176} className={styles.stageRail} />
            {STAGES.map((s, i) => (
              <g key={s.label} className={styles.stage} data-stage={i}>
                <circle cx={182} cy={s.y} r={4} />
                <text x={194} y={s.y + 4}>
                  {s.label}
                </text>
                <text x={303} y={s.y + 4} textAnchor="end" className={styles.stageTag}>
                  {s.tag}
                </text>
              </g>
            ))}
          </g>

          {FLOWS.map((f) => (
            <g key={f.service} data-flow={f.flow} className={`${styles.chip} ${styles.chipTarget}`}>
              <rect x={388} y={f.y - 14} width={84} height={28} rx={6} />
              <text x={430} y={f.y + 4} textAnchor="middle">
                {f.service}
              </text>
            </g>
          ))}
        </svg>

        <ol className={styles.log} aria-hidden="true">
          {LOG_LINES.map(([flow, verb, target, note]) => (
            <li key={verb + target}>
              <span className={styles.logVerb} data-flow={flow ?? undefined}>
                {verb}
              </span>{" "}
              {target} <span className={styles.logNote}>{note}</span>
            </li>
          ))}
        </ol>
        <button ref={triggerRef} type="button" className={styles.simTrigger} onClick={open} disabled={loading}>
          <span aria-hidden="true">▷</span> {t("auth.sim.open")}
        </button>
        {failed && (
          <p role="alert" className={styles.simError}>
            {t("auth.sim.failed")}
          </p>
        )}
      </div>

      <div>
        <p className={styles.tagline}>{t("auth.visual.tagline")}</p>
        <p className={styles.note}>{t("auth.visual.note")}</p>
      </div>
    </aside>
  );
}
