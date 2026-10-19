import {
  describeEvent,
  describeType,
  expectedProbe,
  isProbeType,
  noDestination,
  pipelineRoles,
  type NoteInput,
  probeOf,
  stageHint,
} from "./event-notes";
import { createT } from "../../lib/i18n/dictionary";

const t = createT("vi");
const en = createT("en");

const STAGES = ["received", "verified", "persisted", "normalized", "routed", "delivering"];

/** summary 6 chấm: mặc định ok hết, ghi đè từng chặng. */
function summary(
  over: Record<string, string> = {},
  delivering: { okCount: number; total: number } = { okCount: 1, total: 1 },
) {
  return STAGES.map((stage) => ({ stage, status: over[stage] ?? "ok", ...(stage === "delivering" ? delivering : {}) }));
}

function row(over: Partial<NoteInput> = {}): NoteInput {
  return {
    provider: "payos",
    providerLabel: "PayOS",
    type: "payment.received",
    status: "succeeded",
    summary: summary(),
    failedAt: null,
    ...over,
  };
}

const probeSummary = summary(
  { normalized: "warning", routed: "skipped", delivering: "skipped" },
  { okCount: 0, total: 0 },
);

describe("describeType — sự kiện LÀ gì (theo docs/EVENT-CATALOG.md)", () => {
  it.each([
    ["payment.received", "Nhận tiền (PayOS)"],
    ["payment.sent", "Chuyển tiền đi (PayOS)"],
    ["payment.failed", "PayOS báo thanh toán thất bại"],
    ["payment.refunded", "Hoàn tiền (PayOS)"],
    ["repo.push", "Đẩy commit lên kho mã"],
    ["repo.pull_request.opened", "Mở pull request"],
    ["repo.pull_request.merged", "Pull request được hợp nhất"],
    ["repo.pull_request.labeled", "Pull request: labeled"],
    ["repo.issue.opened", "Mở issue"],
    ["repo.issue.assigned", "Issue: assigned"],
    ["github.release.published", "PayOS: github.release.published"],
    ["menu.updated", "PayOS: menu.updated"],
  ])("%s -> %s", (type, text) => {
    expect(describeType(type, "PayOS", t)).toBe(text);
  });
});

describe("describeEvent — cột Ghi chú", () => {
  it("payos.webhook_test: nói rõ là request kiểm tra khi kết nối, dừng ở Normalize là ĐÚNG (tone expected)", () => {
    const n = describeEvent(row({ type: "payos.webhook_test", summary: probeSummary }), t);
    expect(n.tone).toBe("expected");
    expect(n.text).toContain("PayOS kiểm tra URL của hub khi bấm “Kết nối PayOS”");
    expect(n.text).toContain("không phải thanh toán, không phải tạo QR");
    expect(n.text).toContain("dừng ở Chuẩn hoá là đúng, không giao đi");
  });

  it("github.ping: GitHub kiểm tra webhook", () => {
    const n = describeEvent(
      row({ provider: "github", providerLabel: "GitHub", type: "github.ping", summary: probeSummary }), t);
    expect(n).toEqual({ text: expect.stringContaining("GitHub gửi ping kiểm tra webhook"), tone: "expected" });
  });

  it("thanh toán giao xong: mô tả + n/n đích", () => {
    expect(describeEvent(row({ summary: summary({}, { okCount: 2, total: 2 }) }), t)).toEqual({
      text: "Nhận tiền (PayOS) — đã giao 2/2 đích",
      tone: "neutral",
    });
  });

  it("bị từ chối: lý do lấy từ failedAt của server (vế đầu), không tự khẳng định 'không lưu'; thiếu -> câu chung", () => {
    const failedAt = {
      stage: "verified",
      reason: { code: "signature_invalid", message: "Chữ ký không hợp lệ — hub trả 401, không lưu sự kiện" },
    };
    const sig = describeEvent(row({ type: null, status: "rejected", failedAt }), t);
    expect(sig).toEqual({ text: "Bị từ chối — Chữ ký không hợp lệ", tone: "error" });
    expect(sig.text).not.toContain("không lưu");
    expect(describeEvent(row({ type: null, status: "rejected" }), t)).toEqual({ text: "Bị từ chối ở bước nhận", tone: "error" });
  });

  it("giao DEAD -> error, nêu đích + HTTP; đang thử lại -> attention", () => {
    const failedAt = {
      stage: "delivering",
      reason: { code: "http_5xx", message: "HTTP 500" },
      destinationName: "Discord",
      httpStatus: 500,
    };
    const dead = describeEvent(
      row({ status: "failed", failedAt, summary: summary({ delivering: "failed" }, { okCount: 0, total: 1 }) }), t);
    expect(dead).toEqual({ text: "Nhận tiền (PayOS) — giao tới Discord (HTTP 500) thất bại", tone: "error" });
    const retry = describeEvent(
      row({ status: "in_progress", failedAt, summary: summary({ delivering: "warning" }, { okCount: 0, total: 1 }) }), t);
    expect(retry.tone).toBe("attention");
    expect(retry.text).toContain("đang chờ thử lại giao tới Discord");
  });

  it("probe nhưng có lỗi thật -> không che lỗi bằng câu 'là đúng'", () => {
    const failedAt = {
      stage: "delivering",
      reason: { code: "timeout", message: "Hết thời gian chờ (5s)" },
      destinationName: "Shop",
    };
    const n = describeEvent(row({ type: "payos.webhook_test", status: "failed", failedAt }), t);
    expect(n.tone).toBe("error");
    expect(n.text).not.toContain("là đúng");
  });

  it("không subscription nhận -> attention; kiểu chưa ánh xạ -> nhắc data dạng raw", () => {
    const s = summary({ routed: "skipped", delivering: "skipped" }, { okCount: 0, total: 0 });
    expect(describeEvent(row({ summary: s }), t)).toEqual({
      text: "Nhận tiền (PayOS) — không có đăng ký nhận nào khớp",
      tone: "attention",
    });
    const unmapped = describeEvent(
      row({
        provider: "github",
        providerLabel: "GitHub",
        type: "github.star.created",
        summary: summary({ normalized: "warning" }),
      }), t);
    expect(unmapped.text).toBe("GitHub: github.star.created — đã giao 1/1 đích · chưa có kiểu chuẩn, dữ liệu dạng thô");
  });

  it("chưa có event: trùng / adapter bỏ qua / normalize DLQ / đang chờ", () => {
    const dup = describeEvent(
      row({ type: null, summary: summary({ persisted: "skipped", normalized: "skipped", routed: "skipped" }) }), t);
    expect(dup).toEqual({ text: expect.stringContaining("ACK trùng"), tone: "expected" });
    const skipped = describeEvent(row({ type: null, summary: summary({ normalized: "skipped" }) }), t);
    expect(skipped.text).toContain("bộ chuyển đổi không sinh sự kiện");
    const dlq = describeEvent(
      row({
        type: null,
        status: "failed",
        failedAt: { stage: "normalized", reason: { code: "normalize_dlq", message: "x" } },
      }), t);
    expect(dlq.tone).toBe("error");
    expect(
      describeEvent(row({ type: null, status: "in_progress", summary: summary({ normalized: "in_progress" }) }), t).text,
    ).toContain("đang chờ chuẩn hoá");
  });

  it.each([
    ["vi", t],
    ["en", en],
  ])("BB-1 (%s): ghi chú không bao giờ nói về đơn hàng", (_locale, tr) => {
    const samples = [
      describeEvent(row(), tr),
      describeEvent(row({ type: "payos.webhook_test", summary: probeSummary }), tr),
      describeEvent(row({ type: "payment.failed" }), tr),
      describeEvent(row({ type: "payment.refunded" }), tr),
      describeEvent(row({ provider: "stripe", type: "stripe.ping", summary: probeSummary, probe: true }), tr),
      describeEvent(row({ type: null, status: "in_progress", summary: summary({ normalized: "in_progress" }) }), tr),
    ];
    for (const n of samples) expect(n.text.toLowerCase()).not.toMatch(/đơn hàng|order/);
  });

  it("en: cùng logic, chữ tiếng Anh, không dấu tiếng Việt", () => {
    expect(describeEvent(row({ summary: summary({}, { okCount: 2, total: 2 }) }), en)).toEqual({
      text: "Money received (PayOS) — delivered to 2/2 destinations",
      tone: "neutral",
    });
    expect(describeType("repo.pull_request.labeled", "GitHub", en)).toBe("Pull request: labeled");
    const probe = describeEvent(row({ type: "payos.webhook_test", summary: probeSummary }), en);
    expect(probe.tone).toBe("expected");
    expect(probe.text).not.toMatch(/[à-ỹđ]/i);
  });
});

describe("probeOf / expectedProbe — MỘT bảng kiểu kiểm tra kết nối", () => {
  it("payos.webhook_test, github.ping -> nhãn 'Kiểm tra kết nối'; kiểu khác / tên thuộc tính Object -> null", () => {
    expect(probeOf("payos.webhook_test")?.label).toBe("journey.probe.label");
    expect(probeOf("github.ping")?.label).toBe("journey.probe.label");
    expect(probeOf("payment.received")).toBeNull();
    expect(probeOf("toString")).toBeNull();
    expect(probeOf(null)).toBeNull();
  });
  it("expectedProbe: có lỗi thật (failedAt) -> null, UI không vẽ trung tính che lỗi", () => {
    const base = { provider: "payos", type: "payos.webhook_test", summary: probeSummary };
    expect(expectedProbe({ ...base, failedAt: null })).not.toBeNull();
    expect(expectedProbe({ ...base, failedAt: { stage: "delivering", reason: { code: "timeout", message: "x" } } })).toBeNull();
  });
  it("A1 chống giả: api-published github.ping, giao 1/1 -> KHÔNG phải probe", () => {
    const spoof = row({ provider: "api", providerLabel: "API", type: "github.ping", summary: summary() });
    expect(expectedProbe(spoof)).toBeNull();
    expect(describeEvent(spoof, t)).toEqual({ text: "API: github.ping — đã giao 1/1 đích", tone: "neutral" });
    expect(stageHint(spoof, { stage: "routed", status: "skipped" }, t)).toBe("Không có đăng ký nhận nào khớp");
  });
  it("A1: đúng provider nhưng có delivery / không dừng ở định tuyến -> không phải probe", () => {
    expect(expectedProbe(row({ type: "payos.webhook_test", summary: summary() }))).toBeNull();
    expect(expectedProbe(row({ provider: "api", type: "payos.webhook_test", summary: probeSummary }))).toBeNull();
    expect(expectedProbe(row({ type: "payos.webhook_test", summary: probeSummary }))?.label).toBe("journey.probe.label");
  });
});

describe("expectedProbe — cờ events.probe của server (ADR-159/163) thắng phỏng đoán", () => {
  it("probe: true + không delivery -> probe, không cần provider/kiểu khớp bảng (không đoán)", () => {
    expect(expectedProbe(row({ provider: "api", type: "payos.webhook_test", summary: probeSummary, probe: true }))?.label).toBe("journey.probe.label");
  });
  it("probe: true nhưng đã có delivery -> không phải probe đúng thiết kế", () => {
    expect(expectedProbe(row({ type: "payos.webhook_test", summary: summary(), probe: true }))).toBeNull();
  });
  it("probe: true với kiểu chưa có trong bảng -> câu chung trung tính", () => {
    const p = expectedProbe(row({ provider: "stripe", type: "stripe.ping", summary: probeSummary, probe: true }));
    expect(p).toMatchObject({ provider: "stripe", label: "journey.probe.label" });
    expect(describeEvent(row({ provider: "stripe", type: "stripe.ping", summary: probeSummary, probe: true }), t).tone).toBe("expected");
  });
  it("probe: false -> KHÔNG phải probe dù tên kiểu + summary khớp bảng (service tự publish trùng tên)", () => {
    expect(expectedProbe(row({ type: "payos.webhook_test", summary: probeSummary, probe: false }))).toBeNull();
  });
  it("probe: true nhưng có lỗi thật -> không che lỗi", () => {
    expect(expectedProbe(row({ type: "github.ping", probe: true, failedAt: { stage: "normalized", reason: { code: "x", message: "y" } } }))).toBeNull();
  });
  it("vắng cờ (server cũ) -> vẫn phỏng đoán như trước", () => {
    expect(expectedProbe(row({ provider: "api", type: "payos.webhook_test", summary: probeSummary }))).toBeNull();
    expect(expectedProbe(row({ type: "payos.webhook_test", summary: probeSummary }))?.label).toBe("journey.probe.label");
  });
});

describe("stageHint — dòng lý do trong tooltip chấm chặng", () => {
  it("probe: chấm Normalize vàng giải thích là cố ý; Định tuyến bỏ qua cũng vậy", () => {
    const i = { provider: "payos", type: "payos.webhook_test", failedAt: null, summary: probeSummary };
    expect(stageHint(i, { stage: "normalized", status: "warning" }, t)).toBe(
      "PayOS kiểm tra URL khi kết nối — dừng ở đây là đúng, không giao đi",
    );
    expect(stageHint(i, { stage: "routed", status: "skipped" }, t)).toContain("cố ý không định tuyến");
    expect(stageHint(i, { stage: "delivering", status: "skipped" }, t)).toBe("Không chạy — dừng ở chặng trước");
    expect(isProbeType("payos.webhook_test")).toBe(true);
    expect(isProbeType("payment.received")).toBe(false);
  });

  it("chấm trùng chặng failedAt -> lý do của server; chấm ok -> null", () => {
    const failedAt = {
      stage: "delivering",
      reason: { code: "http_5xx", message: "HTTP 500 — Đích trả lỗi" },
      destinationName: "Discord",
      httpStatus: 500,
    };
    const i = { provider: "payos", type: "payment.received", failedAt, summary: summary() };
    expect(stageHint(i, { stage: "delivering", status: "failed" }, t)).toBe("Discord (HTTP 500): HTTP 500 — Đích trả lỗi");
    expect(stageHint(i, { stage: "verified", status: "ok" }, t)).toBeNull();
  });

  it("kiểu chưa ánh xạ (không phải probe) -> nhắc catalog; trùng -> 'đã nhận trước đó'", () => {
    const i = { provider: "github", type: "github.star.created", failedAt: null, summary: summary() };
    expect(stageHint(i, { stage: "normalized", status: "warning" }, t)).toContain("chưa ánh xạ");
    expect(
      stageHint({ provider: "payos", type: null, failedAt: null, summary: summary() }, { stage: "persisted", status: "skipped" }, t),
    ).toContain("Trùng");
  });
});

describe("stageHint — chấm Lưu (persisted) bị bỏ qua (M1)", () => {
  const persisted = { stage: "persisted", status: "skipped" };
  it("[PK:T16] (phần r) REVIEW-PK5-R2 T-b: nguồn chưa xác thực (chấm Xác thực warning, verified=false) trùng -> 'Trùng', không phải 'chưa chạy'", () => {
    const dup = { provider: "generic", type: null, failedAt: null, verified: false, summary: summary({ verified: "warning" }) };
    expect(stageHint(dup, persisted, t)).toContain("Trùng");
    // warning ở Xác thực mà KHÔNG phải nguồn chưa xác thực -> vẫn coi là chưa qua.
    expect(stageHint({ ...dup, verified: undefined }, persisted, t)).toBe("Không chạy — dừng ở chặng trước");
  });
  it("REJECTED (chữ ký sai, dừng ở verified) -> 'dừng ở chặng trước', KHÔNG phải 'Trùng'", () => {
    const rejected = row({
      type: null,
      status: "rejected",
      summary: summary({ verified: "failed", persisted: "skipped", normalized: "skipped", routed: "skipped", delivering: "skipped" }, { okCount: 0, total: 0 }),
      failedAt: { stage: "verified", reason: { code: "signature_invalid", message: "Chữ ký không hợp lệ" } },
    });
    expect(stageHint(rejected, persisted, t)).toBe("Không chạy — dừng ở chặng trước");
  });
  it("DUPLICATE (đã qua xác thực) -> 'Trùng — đã nhận trước đó'", () => {
    const dup = row({ type: null, summary: summary({ persisted: "skipped", normalized: "skipped", routed: "skipped", delivering: "skipped" }, { okCount: 0, total: 0 }) });
    expect(stageHint(dup, persisted, t)).toBe("Trùng — đã nhận trước đó, không lưu lại");
  });
});

describe("noDestination + pipelineRoles — mờ sau điểm dừng (ADR-259)", () => {
  const noSub = summary({ routed: "skipped", delivering: "skipped" }, { okCount: 0, total: 0 });
  const push = (over: Partial<NoteInput> = {}) =>
    row({ provider: "github", providerLabel: "GitHub", type: "repo.push", summary: noSub, ...over });

  it("repo.push không subscription: noDestination, Route = stop, Giao mờ", () => {
    const r = push();
    expect(noDestination(r)).toBe(true);
    const { roles, stopIdx } = pipelineRoles(r);
    expect(roles).toEqual(["real", "real", "real", "real", "stop", "faded"]);
    expect(stopIdx).toBe(4);
  });

  it("succeeded có giao: không đổi, 6 chấm real", () => {
    const r = row();
    expect(noDestination(r)).toBe(false);
    expect(pipelineRoles(r).roles.every((x) => x === "real")).toBe(true);
  });

  it("ping kiểm tra: không phải noDestination; routed + delivering mờ", () => {
    const r = row({ provider: "github", type: "github.ping", probe: true, summary: probeSummary });
    expect(noDestination(r)).toBe(false);
    expect(pipelineRoles(r).roles).toEqual(["real", "real", "real", "real", "faded", "faded"]);
  });

  it("bị từ chối: Verify failed là điểm dừng, 4 chấm sau mờ", () => {
    const r = row({
      type: null,
      status: "rejected",
      summary: summary({ verified: "failed", persisted: "skipped", normalized: "skipped", routed: "skipped", delivering: "skipped" }, { okCount: 0, total: 0 }),
      failedAt: { stage: "verified", reason: { code: "bad_signature", message: "x" } },
    });
    expect(noDestination(r)).toBe(false);
    expect(pipelineRoles(r).roles).toEqual(["real", "real", "faded", "faded", "faded", "faded"]);
  });

  it("trùng (type null): persisted giữ ⊘ làm điểm dừng, sau đó mờ", () => {
    const r = row({
      type: null,
      summary: summary({ persisted: "skipped", normalized: "skipped", routed: "skipped", delivering: "skipped" }, { okCount: 0, total: 0 }),
    });
    expect(pipelineRoles(r).roles).toEqual(["real", "real", "real", "faded", "faded", "faded"]);
  });

  it("đang xử lý (pending) không bị coi là dừng / không mờ", () => {
    const r = row({ status: "in_progress", summary: summary({ routed: "pending", delivering: "pending" }, { okCount: 0, total: 0 }) });
    expect(noDestination(r)).toBe(false);
    expect(pipelineRoles(r).roles.every((x) => x === "real")).toBe(true);
  });
});
