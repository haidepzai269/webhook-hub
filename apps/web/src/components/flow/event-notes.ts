/**
 * Cột "Ghi chú" của Nhật ký sự kiện + dòng lý do trong tooltip chấm chặng — logic thuần.
 * Từ những gì hàng `/flow/executions` ĐÃ có (type chuẩn, provider, status, summary, failedAt) dựng một câu
 * người đọc được: sự kiện này LÀ gì và dừng/hỏng ở đâu. Không gọi thêm API, không đổi backend.
 * Từ vựng theo docs/EVENT-CATALOG.md (`payment.*`, `repo.*`) — trung lập miền (BB-1: hub không biết nghiệp vụ).
 * Kiểu cấu trúc tối thiểu (không phụ thuộc @hub/flow) để test thuần được.
 * i18n: mọi hàm sinh chữ nhận `t` (useT() ở component, createT(locale) ở test); ProbeInfo giữ KHOÁ, không giữ chữ.
 */
import type { MessageKey, TranslateFn } from "../../lib/i18n/dictionary";

type Status = "succeeded" | "failed" | "in_progress" | "rejected";

interface DotLike {
  stage: string;
  status: string;
  okCount?: number;
  total?: number;
}

interface FailedAtLike {
  stage: string;
  reason: { code: string; message: string };
  destinationName?: string;
  httpStatus?: number | null;
}

export interface NoteInput {
  provider: string;
  providerLabel: string;
  type: string | null;
  status: Status;
  summary: DotLike[];
  failedAt: FailedAtLike | null;
  /** events.probe của server (ADR-159, ADR-163). Vắng = server cũ -> phỏng đoán theo tên kiểu. */
  probe?: boolean;
  /** PK5 (ADR-206): false = nguồn `unverified` — chấm Xác thực là warning (unverified_source) nhưng request ĐÃ qua. */
  verified?: boolean;
}

/** neutral = bình thường · expected = trông lạ nhưng đúng thiết kế · attention = cần xem cấu hình · error = hỏng. */
export type NoteTone = "neutral" | "expected" | "attention" | "error";

export interface EventNote {
  text: string;
  tone: NoteTone;
}

/**
 * Request kiểm tra của chính provider (ADR-159): adapter gắn kiểu riêng, normalized:false, không định tuyến.
 * Chấm Normalize "!" + Định tuyến "bỏ qua" là ĐÚNG — UI vẽ trung tính (không vàng), nhãn kết quả riêng,
 * ghi chú + tooltip nói rõ. MỘT bảng duy nhất ở đây — thêm provider có probe = thêm một dòng, không rải `if`.
 */
export interface ProbeInfo {
  /** Provider DUY NHẤT được phép phát kiểu này như request kiểm tra (chặn service tự publish cùng tên kiểu). */
  provider: string;
  /** Khoá nhãn cột "Kết quả" thay cho "Thành công" — `t(probe.label)`. */
  label: MessageKey;
  /** Khoá câu ở cột "Ghi chú". */
  note: MessageKey;
  /** Khoá một dòng trong tooltip chấm Chuẩn hoá. */
  hint: MessageKey;
}

const PROBES: Record<string, ProbeInfo> = {
  "payos.webhook_test": {
    provider: "payos",
    label: "journey.probe.label",
    note: "journey.probe.payos.note",
    hint: "journey.probe.payos.hint",
  },
  "github.ping": {
    provider: "github",
    label: "journey.probe.label",
    note: "journey.probe.github.note",
    hint: "journey.probe.github.hint",
  },
};

export function probeOf(type: string | null): ProbeInfo | null {
  return type !== null && Object.hasOwn(PROBES, type) ? PROBES[type] : null;
}

export function isProbeType(type: string | null): boolean {
  return probeOf(type) !== null;
}

type ProbeInput = Pick<NoteInput, "type" | "provider" | "failedAt" | "summary" | "probe" | "verified">;

/** Probe do adapter đánh dấu nhưng kiểu chưa có trong bảng PROBES (provider mới) — câu chung, vẫn trung tính. */
const GENERIC_PROBE: Omit<ProbeInfo, "provider"> = {
  label: "journey.probe.label",
  note: "journey.probe.generic.note",
  hint: "journey.probe.generic.hint",
};

/**
 * Hàng là probe ĐÚNG như thiết kế → UI vẽ trung tính thay vì cảnh báo. Có failedAt (lỗi thật) → không che, trả null.
 * - Có cờ `probe` từ server (events.probe, ADR-159 — ADAPTER đặt, service publish qua /v1/p không đặt được): tin cờ.
 *   probe = cờ && không failedAt && không có delivery nào; nhãn theo bảng PROBES (hoặc câu chung). false → không
 *   phải probe, kể cả khi tên kiểu trùng.
 * - Không có cờ (server cũ): phỏng đoán — chỉ tên kiểu thì giả được, nên phải khớp CẢ provider của bảng PROBES,
 *   Normalize cảnh báo/bỏ qua, Định tuyến bỏ qua và không có delivery nào.
 */
export function expectedProbe(i: ProbeInput): ProbeInfo | null {
  if (i.probe !== undefined) {
    const isProbe = i.probe && !i.failedAt && (dot(i.summary, "delivering")?.total ?? 0) === 0;
    return isProbe ? (probeOf(i.type) ?? { provider: i.provider, ...GENERIC_PROBE }) : null;
  }
  const probe = probeOf(i.type);
  if (!probe || i.failedAt || i.provider !== probe.provider) return null;
  const normalized = dot(i.summary, "normalized")?.status;
  const routed = dot(i.summary, "routed")?.status;
  const delivering = dot(i.summary, "delivering");
  const stopped = (normalized === "warning" || normalized === "skipped") && routed === "skipped";
  return stopped && (delivering?.total ?? 0) === 0 ? probe : null;
}

/**
 * "Không có đích" (ADR-259): sự kiện chuẩn đã nhận + lưu + chuẩn hoá nhưng KHÔNG subscription nào khớp kiểu →
 * chặng Định tuyến `skipped` (server: reason `no_subscription`), Giao `skipped` total 0, không lỗi, không phải probe.
 * Đây là dừng có chủ đích của cấu hình, không phải hỏng — UI vẽ trung tính + gợi ý tạo Subscription. Không cần đổi backend.
 */
export function noDestination(i: ProbeInput): boolean {
  if (i.type === null || i.failedAt) return false;
  const routed = dot(i.summary, "routed");
  const normalized = dot(i.summary, "normalized");
  if (routed?.status !== "skipped" || !normalized || normalized.status === "skipped") return false;
  if (i.summary.some((d) => d.status === "failed")) return false;
  if ((dot(i.summary, "delivering")?.total ?? 0) !== 0) return false;
  return expectedProbe(i) === null;
}

/**
 * Vai của từng chấm trong dải 6 ô (giữ 6 ô để hàng thẳng cột):
 * - `real`: chấm có trạng thái thật (ok/warning/fail/probe…) hoặc điểm dừng có chủ đích kiểu trùng / adapter bỏ qua (⊘).
 * - `stop`: Định tuyến của "không có đích" — dừng có chủ đích, kèm số 0.
 * - `faded`: SAU điểm dừng (skipped, không áp dụng) — chấm nhỏ mờ, đường nối nét đứt.
 * `stopIdx`: chỉ số điểm dừng; đường nối vào ô i > stopIdx là nét đứt.
 */
export type DotRole = "real" | "stop" | "faded";

export function pipelineRoles(i: ProbeInput): { roles: DotRole[]; stopIdx: number } {
  const n = i.summary.length;
  let stopIdx = -1;
  i.summary.forEach((d, k) => {
    if (d.status !== "skipped") stopIdx = k;
  });
  const noDest = noDestination(i);
  const routedIdx = i.summary.findIndex((d) => d.stage === "routed");
  if (noDest && routedIdx >= 0) stopIdx = routedIdx;
  else if (i.type === null && !i.failedAt && !i.summary.some((d) => d.status === "failed") && stopIdx + 1 < n) {
    // Trùng / adapter không sinh event: chấm skipped ngay sau chấm thật cuối là điểm dừng (⊘ giữ nguyên).
    stopIdx += 1;
  }
  const roles = i.summary.map((d, k): DotRole =>
    noDest && k === routedIdx ? "stop" : k > stopIdx && d.status === "skipped" ? "faded" : "real",
  );
  return { roles, stopIdx };
}

const PR_ACTIONS: Record<string, MessageKey> = {
  opened: "journey.pr.opened",
  closed: "journey.pr.closed",
  reopened: "journey.pr.reopened",
  merged: "journey.pr.merged",
  synchronize: "journey.pr.synchronize",
  edited: "journey.pr.edited",
};

const ISSUE_ACTIONS: Record<string, MessageKey> = {
  opened: "journey.issue.opened",
  closed: "journey.issue.closed",
  reopened: "journey.issue.reopened",
  edited: "journey.issue.edited",
  labeled: "journey.issue.labeled",
};

const PAYMENT_TYPES: Record<string, MessageKey> = {
  "payment.received": "journey.type.payment-received",
  "payment.sent": "journey.type.payment-sent",
  "payment.failed": "journey.type.payment-failed",
  "payment.refunded": "journey.type.payment-refunded",
};

/** Sự kiện này LÀ gì — chỉ từ kiểu chuẩn + provider (catalog §3, §4). */
export function describeType(type: string, providerLabel: string, t: TranslateFn): string {
  if (Object.hasOwn(PAYMENT_TYPES, type)) return t(PAYMENT_TYPES[type], { provider: providerLabel });
  if (type === "repo.push") return t("journey.type.repo-push");
  if (type.startsWith("repo.pull_request.")) {
    const action = type.slice("repo.pull_request.".length);
    return Object.hasOwn(PR_ACTIONS, action) ? t(PR_ACTIONS[action]) : t("journey.pr.other", { action });
  }
  if (type.startsWith("repo.issue.")) {
    const action = type.slice("repo.issue.".length);
    return Object.hasOwn(ISSUE_ACTIONS, action) ? t(ISSUE_ACTIONS[action]) : t("journey.issue.other", { action });
  }
  // Ngoài catalog (github.release, kiểu tự phát của service…): nói nguồn + kiểu, không đoán nghĩa.
  return t("journey.type.other", { provider: providerLabel, type });
}

function dot(summary: DotLike[], stage: string): DotLike | undefined {
  return summary.find((d) => d.stage === stage);
}

function deliveryFailure(f: FailedAtLike, t: TranslateFn): string {
  const dest = f.destinationName ?? t("journey.note.destination-fallback");
  const why = f.httpStatus ? `HTTP ${f.httpStatus}` : f.reason.code;
  return `${dest} (${why})`;
}

/** Ghi chú một dòng cho hàng nhật ký. */
export function describeEvent(i: NoteInput, t: TranslateFn): EventNote {
  const prov = i.providerLabel || i.provider;

  if (i.status === "rejected") {
    // Lý do lấy từ server (reason do buildEventFlow dựng); chỉ giữ vế đầu "X không hợp lệ" cho gọn.
    const why = i.failedAt?.reason.message.split(" — ")[0] || i.failedAt?.reason.code;
    return { text: why ? t("journey.note.rejected-why", { why }) : t("journey.note.rejected"), tone: "error" };
  }

  if (i.type === null) {
    // Chưa có event chuẩn: trùng, adapter bỏ qua, normalize hỏng, hoặc đang chờ normalize.
    if (dot(i.summary, "persisted")?.status === "skipped") {
      return { text: t("journey.note.duplicate", { provider: prov }), tone: "expected" };
    }
    if (i.failedAt?.stage === "normalized") {
      return { text: t("journey.note.normalize-failed"), tone: "error" };
    }
    if (dot(i.summary, "normalized")?.status === "skipped") {
      return { text: t("journey.note.adapter-skipped", { provider: prov }), tone: "expected" };
    }
    return { text: t("journey.note.waiting-normalize", { provider: prov }), tone: "neutral" };
  }

  const probe = expectedProbe(i);
  if (probe) return { text: t(probe.note), tone: "expected" };

  const what = describeType(i.type, prov, t);
  const routed = dot(i.summary, "routed");
  const delivering = dot(i.summary, "delivering");
  const unmapped = dot(i.summary, "normalized")?.status === "warning";
  const tail = unmapped ? ` · ${t("journey.note.unmapped")}` : "";

  if (i.failedAt?.stage === "delivering") {
    // Đang thử lại (in_progress) khác hẳn đã DEAD (failed).
    return i.status === "in_progress"
      ? { text: t("journey.note.retrying", { what, target: deliveryFailure(i.failedAt, t) }), tone: "attention" }
      : { text: t("journey.note.dead", { what, target: deliveryFailure(i.failedAt, t) }), tone: "error" };
  }
  if (i.failedAt) return { text: `${what} — ${i.failedAt.reason.message}`, tone: "error" };

  if (routed?.status === "skipped") {
    return { text: `${t("journey.note.no-subscription", { what })}${tail}`, tone: "attention" };
  }
  const total = delivering?.total ?? 0;
  if (i.status === "succeeded" && total > 0) {
    const ok = delivering?.okCount ?? 0;
    return { text: `${t("journey.note.delivered", { what, ok, total })}${tail}`, tone: "neutral" };
  }
  if (i.status === "in_progress") return { text: `${t("journey.note.processing", { what })}${tail}`, tone: "neutral" };
  return { text: `${what}${tail}`, tone: "neutral" };
}

/**
 * Dòng lý do ngắn cho tooltip một chấm chặng (bản gọn của trang Hành trình sự kiện).
 * `null` = chấm bình thường, tooltip chỉ cần tên chặng + trạng thái.
 */
export function stageHint(i: ProbeInput, d: DotLike, t: TranslateFn): string | null {
  const f = i.failedAt;
  if (f && f.stage === d.stage) {
    return f.stage === "delivering" ? `${deliveryFailure(f, t)}: ${f.reason.message}` : f.reason.message;
  }
  const probe = expectedProbe(i);
  if (d.stage === "normalized" && d.status === "warning") {
    return probe ? t(probe.hint) : t("journey.hint.unmapped");
  }
  if (d.stage === "persisted" && d.status === "skipped") {
    // Chỉ là "trùng" khi đã qua xác thực; dòng REJECTED (chữ ký sai) dừng ở `verified` nên `persisted` cũng skipped.
    // REVIEW-PK5-R2 T-b: nguồn chưa xác thực -> chấm Xác thực warning (lý do unverified_source) vẫn là "đã qua".
    const v = dot(i.summary, "verified")?.status;
    const verifiedOk = (v === "ok" || (v === "warning" && i.verified === false)) && f?.stage !== "verified";
    return verifiedOk ? t("journey.hint.duplicate") : t("journey.hint.not-run");
  }
  if (d.stage === "normalized" && d.status === "skipped" && i.type === null) {
    return dot(i.summary, "persisted")?.status === "skipped"
      ? t("journey.hint.not-run")
      : t("journey.hint.adapter-no-event");
  }
  if (d.stage === "routed" && d.status === "skipped" && i.type !== null) {
    return probe ? t("journey.hint.probe-not-routed") : t("journey.hint.no-subscription");
  }
  if (d.status === "skipped") return t("journey.hint.not-run");
  return null;
}
