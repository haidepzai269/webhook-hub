/**
 * Cột "Ghi chú" của Nhật ký sự kiện + dòng lý do trong tooltip chấm chặng — logic thuần.
 * Từ những gì hàng `/flow/executions` ĐÃ có (type chuẩn, provider, status, summary, failedAt) dựng một câu
 * người đọc được: sự kiện này LÀ gì và dừng/hỏng ở đâu. Không gọi thêm API, không đổi backend.
 * Từ vựng theo docs/EVENT-CATALOG.md (`payment.*`, `repo.*`) — trung lập miền (BB-1: hub không biết nghiệp vụ).
 * Kiểu cấu trúc tối thiểu (không phụ thuộc @hub/flow) để test thuần được.
 */

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
  /** Nhãn cột "Kết quả" thay cho "Thành công". */
  label: string;
  /** Câu ở cột "Ghi chú". */
  note: string;
  /** Một dòng trong tooltip chấm Normalize. */
  hint: string;
}

const PROBES: Record<string, ProbeInfo> = {
  "payos.webhook_test": {
    provider: "payos",
    label: "Kiểm tra kết nối",
    note: "PayOS kiểm tra URL của hub khi bấm “Kết nối PayOS” — không phải thanh toán, không phải tạo QR; dừng ở Normalize là đúng, không giao đi",
    hint: "PayOS kiểm tra URL khi kết nối — dừng ở đây là đúng, không giao đi",
  },
  "github.ping": {
    provider: "github",
    label: "Kiểm tra kết nối",
    note: "GitHub gửi ping kiểm tra webhook — không phải sự kiện repo; dừng ở Normalize là đúng, không giao đi",
    hint: "GitHub ping kiểm tra webhook — dừng ở đây là đúng, không giao đi",
  },
};

export function probeOf(type: string | null): ProbeInfo | null {
  return type !== null && Object.hasOwn(PROBES, type) ? PROBES[type] : null;
}

export function isProbeType(type: string | null): boolean {
  return probeOf(type) !== null;
}

type ProbeInput = Pick<NoteInput, "type" | "provider" | "failedAt" | "summary" | "probe">;

/** Probe do adapter đánh dấu nhưng kiểu chưa có trong bảng PROBES (provider mới) — câu chung, vẫn trung tính. */
const GENERIC_PROBE: Omit<ProbeInfo, "provider"> = {
  label: "Kiểm tra kết nối",
  note: "Provider kiểm tra URL của hub — không phải sự kiện nghiệp vụ; dừng ở Normalize là đúng, không giao đi",
  hint: "Request kiểm tra kết nối của provider — dừng ở đây là đúng, không giao đi",
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

const PR_ACTIONS: Record<string, string> = {
  opened: "Mở pull request",
  closed: "Đóng pull request (không merge)",
  reopened: "Mở lại pull request",
  merged: "Pull request được merge",
  synchronize: "Pull request có commit mới",
  edited: "Sửa pull request",
};

const ISSUE_ACTIONS: Record<string, string> = {
  opened: "Mở issue",
  closed: "Đóng issue",
  reopened: "Mở lại issue",
  edited: "Sửa issue",
  labeled: "Gắn nhãn issue",
};

/** Sự kiện này LÀ gì — chỉ từ kiểu chuẩn + provider (catalog §3, §4). */
export function describeType(type: string, providerLabel: string): string {
  switch (type) {
    case "payment.received":
      return `Nhận tiền (${providerLabel})`;
    case "payment.sent":
      return `Chuyển tiền đi (${providerLabel})`;
    case "payment.failed":
      return `${providerLabel} báo thanh toán thất bại`;
    case "payment.refunded":
      return `Hoàn tiền (${providerLabel})`;
    case "repo.push":
      return "Push commit lên repo";
  }
  if (type.startsWith("repo.pull_request.")) {
    const action = type.slice("repo.pull_request.".length);
    return PR_ACTIONS[action] ?? `Pull request: ${action}`;
  }
  if (type.startsWith("repo.issue.")) {
    const action = type.slice("repo.issue.".length);
    return ISSUE_ACTIONS[action] ?? `Issue: ${action}`;
  }
  // Ngoài catalog (github.release, kiểu tự phát của service…): nói nguồn + kiểu, không đoán nghĩa.
  return `${providerLabel}: ${type}`;
}

function dot(summary: DotLike[], stage: string): DotLike | undefined {
  return summary.find((d) => d.stage === stage);
}

function deliveryFailure(f: FailedAtLike): string {
  const dest = f.destinationName ?? "đích";
  const why = f.httpStatus ? `HTTP ${f.httpStatus}` : f.reason.code;
  return `${dest} (${why})`;
}

/** Ghi chú một dòng cho hàng nhật ký. */
export function describeEvent(i: NoteInput): EventNote {
  const prov = i.providerLabel || i.provider;

  if (i.status === "rejected") {
    // Lý do lấy từ server (reason do buildEventFlow dựng); chỉ giữ vế đầu "X không hợp lệ" cho gọn.
    const why = i.failedAt?.reason.message.split(" — ")[0] || i.failedAt?.reason.code;
    return { text: why ? `Bị từ chối — ${why}` : "Bị từ chối ở bước nhận", tone: "error" };
  }

  if (i.type === null) {
    // Chưa có event chuẩn: trùng, adapter bỏ qua, normalize hỏng, hoặc đang chờ normalize.
    if (dot(i.summary, "persisted")?.status === "skipped") {
      return { text: `${prov} gửi lại sự kiện đã nhận — hub ACK trùng, không xử lý lại`, tone: "expected" };
    }
    if (i.failedAt?.stage === "normalized") {
      return { text: "Normalize thất bại — raw event nằm trong DLQ normalize, cần chạy lại", tone: "error" };
    }
    if (dot(i.summary, "normalized")?.status === "skipped") {
      return { text: `${prov} gửi request mà adapter không sinh sự kiện nào`, tone: "expected" };
    }
    return { text: `Đã nhận từ ${prov} — đang chờ normalize`, tone: "neutral" };
  }

  const probe = expectedProbe(i);
  if (probe) return { text: probe.note, tone: "expected" };

  const what = describeType(i.type, prov);
  const routed = dot(i.summary, "routed");
  const delivering = dot(i.summary, "delivering");
  const unmapped = dot(i.summary, "normalized")?.status === "warning";
  const tail = unmapped ? " · chưa có kiểu chuẩn (data dạng raw)" : "";

  if (i.failedAt?.stage === "delivering") {
    // Đang thử lại (in_progress) khác hẳn đã DEAD (failed).
    return i.status === "in_progress"
      ? { text: `${what} — đang chờ thử lại giao tới ${deliveryFailure(i.failedAt)}`, tone: "attention" }
      : { text: `${what} — giao tới ${deliveryFailure(i.failedAt)} thất bại`, tone: "error" };
  }
  if (i.failedAt) return { text: `${what} — ${i.failedAt.reason.message}`, tone: "error" };

  if (routed?.status === "skipped") {
    return { text: `${what} — không subscription nào nhận${tail}`, tone: "attention" };
  }
  const total = delivering?.total ?? 0;
  if (i.status === "succeeded" && total > 0) {
    return { text: `${what} — đã giao ${delivering?.okCount ?? 0}/${total} đích${tail}`, tone: "neutral" };
  }
  if (i.status === "in_progress") return { text: `${what} — đang xử lý${tail}`, tone: "neutral" };
  return { text: `${what}${tail}`, tone: "neutral" };
}

/**
 * Dòng lý do ngắn cho tooltip một chấm chặng (bản gọn của trang Hành trình sự kiện).
 * `null` = chấm bình thường, tooltip chỉ cần tên chặng + trạng thái.
 */
export function stageHint(i: ProbeInput, d: DotLike): string | null {
  const f = i.failedAt;
  if (f && f.stage === d.stage) {
    return f.stage === "delivering" ? `${deliveryFailure(f)}: ${f.reason.message}` : f.reason.message;
  }
  const probe = expectedProbe(i);
  if (d.stage === "normalized" && d.status === "warning") {
    return probe ? probe.hint : "Kiểu chưa ánh xạ vào catalog — data giữ dạng { raw }";
  }
  if (d.stage === "persisted" && d.status === "skipped") {
    // Chỉ là "trùng" khi đã qua xác thực; dòng REJECTED (chữ ký sai) dừng ở `verified` nên `persisted` cũng skipped.
    const verifiedOk = dot(i.summary, "verified")?.status === "ok" && f?.stage !== "verified";
    return verifiedOk ? "Trùng — đã nhận trước đó, không lưu lại" : "Không chạy — dừng ở chặng trước";
  }
  if (d.stage === "normalized" && d.status === "skipped" && i.type === null) {
    return dot(i.summary, "persisted")?.status === "skipped"
      ? "Không chạy — dừng ở chặng trước"
      : "Adapter không sinh event nào";
  }
  if (d.stage === "routed" && d.status === "skipped" && i.type !== null) {
    return probe ? "Sự kiện kiểm tra — cố ý không định tuyến" : "Không subscription nào nhận";
  }
  if (d.status === "skipped") return "Không chạy — dừng ở chặng trước";
  return null;
}
