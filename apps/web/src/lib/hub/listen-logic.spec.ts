import { createHash } from "crypto";

import { RESERVED_NAMESPACES as COMMON_RESERVED, isReservedType as commonIsReserved } from "@hub/common";
import { ALGO_IN_PREFIX as SERVER_ALGO_IN_PREFIX, type GenericConfig, secretProblem, validateGenericConfig } from "@hub/providers";

import {
  ALGO_IN_PREFIX,
  buildGenericConfig,
  connectionState,
  diagnosisParts,
  type GenericFormValues,
  genericFormIssues,
  HMAC_ALGO_CHOICES,
  idKindOf,
  type InspectRow,
  isReservedType,
  KEY_ENCODING_CHOICES,
  LISTEN_REFRESH_MS,
  listenRefetchInterval,
  playgroundSources,
  RESERVED_NAMESPACES,
  TOKEN_LOCATION_CHOICES,
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

/** Giá trị form mặc định (như `defaultValues` của trang Nguồn) — từng test đè phần cần. */
const FORM: GenericFormValues = {
  scheme: "hmac",
  header: "x-sig",
  encoding: "hex",
  algo: "sha256",
  prefix: "",
  keyEncoding: "utf8",
  location: "header",
  param: "",
  idKind: "field",
  idValue: "transId",
  eventType: "acme.invoice.paid",
};

describe("PK1: form tay \"Nhà cung cấp khác\" dựng verificationConfig đúng khuôn validateGenericConfig", () => {
  it("hmac: header + encoding + khoá chống trùng theo trường", () => {
    expect(buildGenericConfig({ ...FORM, header: " X-Acme-Signature ", encoding: "base64" })).toEqual({
      scheme: "hmac",
      header: "x-acme-signature",
      encoding: "base64",
      keyEncoding: "utf8",
      algo: "sha256",
      idempotency: { field: "transId" },
      eventType: "acme.invoice.paid",
    });
  });

  it("static-token: không có encoding; khoá theo header viết thường", () => {
    expect(buildGenericConfig({ ...FORM, scheme: "static-token", header: "X-Token", idKind: "header", idValue: "X-Event-Id", eventType: "acme.x" })).toEqual({
      scheme: "static-token",
      header: "x-token",
      idempotency: { header: "x-event-id" },
      eventType: "acme.x",
    });
  });

  it("standard-webhooks (cả Svix): không header/encoding; khoá chống trùng bỏ trống = id của bộ header", () => {
    expect(buildGenericConfig({ ...FORM, scheme: "standard-webhooks", header: "x", idKind: "header", idValue: "", eventType: "user.created" })).toEqual({
      scheme: "standard-webhooks",
      eventType: "user.created",
    });
  });
});

describe("review PK1: form tay, Lắng nghe, Playground", () => {
  const base = FORM;

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
    expect(idKindOf({ scheme: "hmac", idKind: "field" })).toBe("field");
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

describe("PK2: form tay — tham số hmac + vị trí token, cùng luật server", () => {
  const KEY = createHash("sha256").update("pk2-web-form").digest();
  const serverIssues = (f: GenericFormValues, secret: string): string[] => {
    const r = validateGenericConfig(buildGenericConfig(f));
    if (!r.ok) return [`config:${(r as { field: string }).field}`];
    const p = secretProblem((r as { config: GenericConfig }).config, secret);
    return p ? ["secret"] : [];
  };

  it("ALGO_IN_PREFIX của web = của server", () => expect(ALGO_IN_PREFIX).toBe(SERVER_ALGO_IN_PREFIX));

  it("round-trip: mọi tổ hợp algo × encoding × keyEncoding × prefix, mọi location -> server nhận đúng điều form gửi", () => {
    const forms: GenericFormValues[] = [];
    for (const algo of HMAC_ALGO_CHOICES) {
      for (const encoding of ["hex", "base64"] as const) {
        for (const keyEncoding of KEY_ENCODING_CHOICES) {
          for (const prefix of ["", "v1=", "x".repeat(32)]) forms.push({ ...FORM, algo, encoding, keyEncoding, prefix });
        }
      }
    }
    for (const location of TOKEN_LOCATION_CHOICES) forms.push({ ...FORM, scheme: "static-token", location, param: "api_key", prefix: "Bearer " });
    for (const f of forms) {
      const built = buildGenericConfig(f);
      const r = validateGenericConfig(built);
      expect({ f, ok: r.ok }).toEqual({ f, ok: true });
      expect((r as unknown as { config: Record<string, unknown> }).config).toMatchObject(built);
    }
    expect(buildGenericConfig({ ...FORM, algo: "from-prefix", prefix: "bỏ qua" })).toEqual(expect.objectContaining({ prefix: "<algo>=" }));
    expect(buildGenericConfig({ ...FORM, algo: "from-prefix" })).not.toHaveProperty("algo");
    expect(buildGenericConfig({ ...FORM, scheme: "static-token", location: "basic", header: "x-t", prefix: "Bearer " })).toEqual({
      scheme: "static-token",
      location: "basic",
      idempotency: { field: "transId" },
      eventType: "acme.invoice.paid",
    });
    expect(buildGenericConfig({ ...FORM, scheme: "static-token", location: "query", param: " token " })).toMatchObject({ location: "query", param: "token" });
    expect(buildGenericConfig({ ...FORM, scheme: "static-token", prefix: "Bearer " })).toMatchObject({ prefix: "Bearer " }); // không trim
  });

  it("genericFormIssues lỗi đúng khi và chỉ khi server lỗi (config hoặc secret)", () => {
    const cases: [GenericFormValues, string][] = [
      [FORM, "utf8-secret-123"],
      [{ ...FORM, header: "" }, "utf8-secret-123"],
      [{ ...FORM, prefix: "x".repeat(33) }, "utf8-secret-123"],
      [{ ...FORM, algo: "from-prefix", prefix: "x".repeat(40) }, "utf8-secret-123"], // tiền tố bị bỏ qua khi đọc từ chữ ký
      [{ ...FORM, keyEncoding: "hex" }, KEY.toString("hex")],
      [{ ...FORM, keyEncoding: "hex" }, "not-hex-secret"],
      [{ ...FORM, keyEncoding: "hex" }, `${KEY.toString("hex")}a`],
      [{ ...FORM, keyEncoding: "base64" }, KEY.toString("base64")],
      [{ ...FORM, keyEncoding: "base64" }, "not base64 !!"],
      [{ ...FORM, scheme: "static-token", location: "basic" }, "hub:pass-123"],
      [{ ...FORM, scheme: "static-token", location: "basic" }, "onlyuser1"],
      [{ ...FORM, scheme: "static-token", location: "query", param: "" }, "tok-123456"],
      [{ ...FORM, scheme: "static-token", location: "query", param: "a b" }, "tok-123456"],
      [{ ...FORM, scheme: "static-token", location: "query", param: "hub.verify_token" }, "tok-123456"],
      [{ ...FORM, eventType: "payment.received" }, "utf8-secret-123"],
    ];
    for (const [f, secret] of cases) {
      const client = genericFormIssues(f, secret).length > 0;
      const server = serverIssues(f, secret).length > 0;
      expect({ f, secret, client }).toEqual({ f, secret, client: server });
    }
  });

  it("diagnosisParts: tham số query hiện là ?tên (không giá trị)", () => {
    expect(diagnosisParts({ ok: false, reason: "token_mismatch", expectedQueryParam: "token" })).toEqual({ reason: "token_mismatch", name: "?token", candidates: [] });
  });
});
