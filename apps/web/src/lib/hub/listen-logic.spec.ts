import { RESERVED_NAMESPACES as COMMON_RESERVED, isReservedType as commonIsReserved } from "@hub/common";
import { validateGenericConfig } from "@hub/providers";

import {
  buildGenericConfig,
  connectionState,
  diagnosisParts,
  type GenericFormValues,
  idKindOf,
  type InspectRow,
  isReservedType,
  LISTEN_REFRESH_MS,
  listenRefetchInterval,
  playgroundSources,
  RESERVED_NAMESPACES,
} from "./listen-logic";

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

describe("PK1: form tay \"Nhà cung cấp khác\" dựng verificationConfig đúng khuôn validateGenericConfig", () => {
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

describe("review PK1: form tay, Lắng nghe, Playground", () => {
  const base: GenericFormValues = { scheme: "hmac-sha256", header: "x-sig", encoding: "hex", idKind: "field", idValue: "transId", eventType: "acme.invoice.paid" };

  it("T-6: buildGenericConfig đi qua validateGenericConfig (server) cho mọi scheme — round-trip không lệch khuôn", () => {
    const forms: GenericFormValues[] = [
      base,
      { ...base, encoding: "base64", idKind: "header", idValue: "X-Event-Id" },
      { ...base, scheme: "static-token", header: "X-Token" },
      { ...base, scheme: "standard-webhooks", idValue: "" },
      { ...base, scheme: "standard-webhooks", idKind: "field", idValue: "webhook-id" },
    ];
    for (const f of forms) {
      const built = buildGenericConfig(f);
      const r = validateGenericConfig(built);
      expect({ f, ok: r.ok }).toEqual({ f, ok: true });
      // Server không thêm/bớt gì ngoài mặc định (encoding hex, khoá webhook-id) -> form gửi đúng điều dev thấy.
      expect((r as unknown as { config: Record<string, unknown> }).config).toMatchObject(built);
    }
  });

  it("T-1: standard-webhooks luôn lấy khoá từ tiêu đề (ẩn lựa chọn trường body) -> svix-id/webhook-id thành {header}", () => {
    expect(idKindOf({ scheme: "standard-webhooks", idKind: "field" })).toBe("header");
    expect(idKindOf({ scheme: "hmac-sha256", idKind: "field" })).toBe("field");
    expect(buildGenericConfig({ ...base, scheme: "standard-webhooks", idKind: "field", idValue: "Webhook-Id" })).toMatchObject({ idempotency: { header: "webhook-id" } });
  });

  it("T-2: bản sao RESERVED_NAMESPACES/isReservedType khớp bản gốc @hub/common (E24) — payment/repo/hub bị chặn ở client", () => {
    expect([...RESERVED_NAMESPACES]).toEqual([...COMMON_RESERVED]);
    for (const t of ["payment.received", "repo.push", "hub.project.storage", "payment", "bank.transaction.received", "payments.x", "acme.repo"]) {
      expect({ t, r: isReservedType(t) }).toEqual({ t, r: commonIsReserved(t) });
    }
    expect(isReservedType("payment.received")).toBe(true);
    expect(isReservedType("bank.transaction.received")).toBe(false);
  });

  it("T-5: 404 -> dừng poll; lỗi tạm (mạng, 500) hoặc không lỗi -> poll tiếp 2s", () => {
    expect(listenRefetchInterval({ status: 404, message: "not_found" })).toBe(false);
    expect(listenRefetchInterval({ status: 500 })).toBe(LISTEN_REFRESH_MS);
    expect(listenRefetchInterval(new TypeError("Failed to fetch"))).toBe(LISTEN_REFRESH_MS);
    expect(listenRefetchInterval(null)).toBe(LISTEN_REFRESH_MS);
  });

  it("TB-1: Playground lọc nguồn generic (chưa ký theo cấu hình riêng) và đếm số đã ẩn", () => {
    const list = [{ id: "a", provider: "github" }, { id: "b", provider: "generic" }, { id: "c", provider: "payos" }];
    expect(playgroundSources(list)).toEqual({ usable: [list[0], list[2]], hiddenGeneric: 1 });
    expect(playgroundSources(undefined)).toEqual({ usable: [], hiddenGeneric: 0 });
  });
});
