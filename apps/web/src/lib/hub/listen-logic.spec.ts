import { buildGenericConfig, connectionState, diagnosisParts, type InspectRow } from "./listen-logic";

/**
 * PK1 (SPEC-provider-khac §3.3, ADR-202): dòng trạng thái kết nối của tab "Lắng nghe" lấy từ raw_events gần nhất
 * (`GET /api/v1/sources/:id/inspect`). "Request đầu tiên ✓" = có một ACCEPTED — tạo source xong chưa phải là nối được.
 */
const row = (id: string, status: string, diagnosis: InspectRow["diagnosis"], at = "2026-10-13T10:00:00Z"): InspectRow => ({ id, status, receivedAt: at, diagnosis });

describe("[PK:T5] trạng thái kết nối: chờ -> ✓ khi có ACCEPTED đầu tiên", () => {
  it("chưa có request -> chờ", () => {
    expect(connectionState([])).toEqual({ kind: "waiting" });
    expect(connectionState(undefined)).toEqual({ kind: "waiting" });
  });

  it("chỉ có REJECTED -> trượt, lấy chẩn đoán của REJECTED gần nhất (chỉ tên header/trường)", () => {
    const rows = [
      row("r2", "REJECTED", { ok: false, reason: "missing_header", expectedHeader: "x-acme-signature", candidateHeaders: ["x-sig"] }, "2026-10-13T10:00:02Z"),
      row("r1", "REJECTED", { ok: false, reason: "signature_mismatch", expectedHeader: "x-acme-signature" }, "2026-10-13T10:00:01Z"),
    ];
    expect(connectionState(rows)).toEqual({ kind: "failing", diagnosis: rows[0].diagnosis });
  });

  it("chờ -> ✓: ACCEPTED đầu tiên tới thì chuyển sang ✓ (kể cả khi trước đó trượt)", () => {
    const failing = [row("r1", "REJECTED", { ok: false, reason: "signature_mismatch", expectedHeader: "x-signature" })];
    expect(connectionState(failing).kind).toBe("failing");
    const after = [row("r2", "ACCEPTED", { ok: true, reason: "ok" }, "2026-10-13T10:00:05Z"), ...failing];
    expect(connectionState(after)).toEqual({ kind: "connected", lastFailure: null });
  });

  it("đã ✓ mà request mới nhất trượt -> vẫn ✓, kèm lần trượt gần nhất để dev thấy", () => {
    const d = { ok: false, reason: "token_mismatch", expectedHeader: "x-token" } as const;
    const rows = [row("r3", "REJECTED", d, "2026-10-13T10:00:09Z"), row("r2", "ACCEPTED", { ok: true, reason: "ok" }, "2026-10-13T10:00:05Z")];
    expect(connectionState(rows)).toEqual({ kind: "connected", lastFailure: d });
  });

  it("DUPLICATE không phải bằng chứng nối được; ACCEPTED có lỗi ánh xạ vẫn là ✓ (request đã vào)", () => {
    expect(connectionState([row("d", "DUPLICATE", { ok: true })]).kind).toBe("waiting");
    expect(connectionState([row("a", "ACCEPTED", { ok: false, reason: "mapping_field_missing", field: "soTien" })]).kind).toBe("connected");
  });

  it("diagnosisParts chỉ đọc tên header/trường — không bao giờ có giá trị", () => {
    expect(diagnosisParts({ ok: false, reason: "missing_header", expectedHeader: "x-acme-signature", candidateHeaders: ["x-sig"] })).toEqual({
      reason: "missing_header",
      name: "x-acme-signature",
      candidates: ["x-sig"],
    });
    expect(diagnosisParts({ ok: false, reason: "missing_idempotency_key", expectedField: "transId" })).toEqual({ reason: "missing_idempotency_key", name: "transId", candidates: [] });
    expect(diagnosisParts({ ok: false })).toEqual({ reason: "unknown", name: null, candidates: [] });
  });
});

describe("PK1: form tay \"Provider khác\" dựng verificationConfig đúng khuôn validateGenericConfig", () => {
  it("hmac-sha256: header + encoding + khoá chống trùng theo trường", () => {
    expect(buildGenericConfig({ scheme: "hmac-sha256", header: " X-Acme-Signature ", encoding: "base64", idKind: "field", idValue: "transId", eventType: "acme.invoice.paid" })).toEqual({
      scheme: "hmac-sha256",
      header: "x-acme-signature",
      encoding: "base64",
      idempotency: { field: "transId" },
      eventType: "acme.invoice.paid",
    });
  });

  it("static-token: không có encoding; khoá theo header viết thường", () => {
    expect(buildGenericConfig({ scheme: "static-token", header: "X-Token", encoding: "hex", idKind: "header", idValue: "X-Event-Id", eventType: "acme.x" })).toEqual({
      scheme: "static-token",
      header: "x-token",
      idempotency: { header: "x-event-id" },
      eventType: "acme.x",
    });
  });

  it("standard-webhooks (cả Svix): không header/encoding; khoá chống trùng bỏ trống = id của bộ header", () => {
    expect(buildGenericConfig({ scheme: "standard-webhooks", header: "x", encoding: "hex", idKind: "header", idValue: "", eventType: "user.created" })).toEqual({
      scheme: "standard-webhooks",
      eventType: "user.created",
    });
  });
});
