import { createHash } from "crypto";

import { RESERVED_NAMESPACES as COMMON_RESERVED, isReservedType as commonIsReserved } from "@hub/common";
import {
  ACK_REJECT_STATUSES,
  ACK_SUCCESS_STATUSES,
  ALGO_IN_PREFIX as SERVER_ALGO_IN_PREFIX,
  COMMON_REQUEST_HEADER_PREFIXES as SERVER_COMMON_PREFIXES,
  COMMON_REQUEST_HEADERS as SERVER_COMMON_HEADERS,
  ECHO_RESPONDS,
  FORWARD_HEADERS_FORBIDDEN as SERVER_FORWARD_FORBIDDEN,
  FORWARD_HEADERS_MAX as SERVER_FORWARD_MAX,
  type GenericConfig,
  UNVERIFIED_MAX_BODY_BYTES,
  HANDSHAKE_KINDS,
  IDEMPOTENCY_KINDS,
  PATH_MAX_DEPTH as SERVER_PATH_MAX_DEPTH,
  PATH_SEGMENT_RE as SERVER_PATH_SEGMENT_RE,
  idempotencyPathProblem,
  secretProblem,
  validateGenericConfig,
} from "@hub/providers";

import {
  ACK_REJECT_CHOICES,
  ACK_SUCCESS_CHOICES,
  AFTER_VERIFY_CHOICES,
  ALGO_IN_PREFIX,
  COMMON_REQUEST_HEADER_PREFIXES,
  COMMON_REQUEST_HEADERS,
  ECHO_RESPOND_CHOICES,
  buildGenericConfig,
  FORWARD_HEADERS_FORBIDDEN,
  FORWARD_HEADERS_MAX,
  UNVERIFIED_FORM_DEFAULTS,
  UNVERIFIED_MAX_BODY_KB,
  connectionState,
  diagnosisParts,
  type GenericFormValues,
  genericFormIssues,
  HANDSHAKE_CHOICES,
  HANDSHAKE_FORM_DEFAULTS,
  HMAC_ALGO_CHOICES,
  ID_KIND_CHOICES,
  idKindOf,
  idempotencyOf,
  isIdempotencyPath,
  LISTEN_REASON_KEYS,
  PATH_MAX_DEPTH,
  PATH_SEGMENT_RE,
  type InspectRow,
  isReservedType,
  isSnsSubscribeUrl,
  KEY_ENCODING_CHOICES,
  LISTEN_REFRESH_MS,
  listenRefetchInterval,
  pendingSubscribeUrl,
  playgroundSources,
  RESERVED_NAMESPACES,
  subscribeTopicArn,
  SECRET_MAX,
  SECRET_MIN,
  TEMPLATE_FORM_DEFAULTS,
  TEMPLATE_PRESETS,
  type TemplatePreset,
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
    expect(connectionState(after)).toEqual({ kind: "connected", lastFailure: null, handshake: null, unverified: false });
  });

  it("đã ✓ mà request mới nhất trượt -> vẫn ✓, kèm lần trượt gần nhất để dev thấy", () => {
    const d = { ok: false, reason: "token_mismatch", expectedHeader: "x-token" } as const;
    const rows = [row("r3", "REJECTED", d, "2026-10-13T10:00:09Z"), row("r2", "ACCEPTED", { ok: true, reason: "ok" }, "2026-10-13T10:00:05Z")];
    expect(connectionState(rows)).toEqual({ kind: "connected", lastFailure: d, handshake: null, unverified: false });
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
    // Review PK3 T-6: kv thiếu khoá thời điểm -> nêu tên khoá + tiêu đề.
    expect(diagnosisParts({ ok: false, reason: "missing_kv_key", expectedHeader: "stripe-signature", expectedKvKey: "t" })).toEqual({ reason: "missing_kv_key", name: "t (stripe-signature)", candidates: [] });
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
  ...TEMPLATE_FORM_DEFAULTS,
  ...HANDSHAKE_FORM_DEFAULTS,
  ...UNVERIFIED_FORM_DEFAULTS,
};

describe("[PK:T10] (phần d) PK4 console: Lắng nghe hiện \"Đã bắt tay ✓\", SubscribeURL chỉ là link cho dev bấm", () => {
  const hs = (id: string, handshake: InspectRow["handshake"], at: string): InspectRow => ({ ...row(id, "REJECTED", { ok: true, reason: "handshake" }, at), handshake });

  it("chỉ có dòng bắt tay -> handshaken (không phải trượt); trượt mới hơn bắt tay -> failing; ACCEPTED -> connected kèm bắt tay", () => {
    const h = hs("h1", { kind: "query-echo" }, "2026-10-13T10:00:01Z");
    expect(connectionState([h])).toEqual({ kind: "handshaken", handshake: { kind: "query-echo" } });
    const bad = row("r2", "REJECTED", { ok: false, reason: "signature_mismatch", expectedHeader: "x-sig" }, "2026-10-13T10:00:02Z");
    expect(connectionState([bad, h]).kind).toBe("failing");
    const acc = row("a3", "ACCEPTED", { ok: true, reason: "ok" }, "2026-10-13T10:00:03Z");
    expect(connectionState([acc, bad, h])).toEqual({ kind: "connected", lastFailure: null, handshake: { kind: "query-echo" }, unverified: false });
    // Dòng mới nhất là bắt tay lặp lại (Zoom 72 giờ) -> không phải "request mới nhất trượt".
    expect(connectionState([hs("h4", { kind: "hmac-echo" }, "2026-10-13T10:00:04Z"), acc])).toMatchObject({ kind: "connected", lastFailure: null });
  });

  it("review PK4 T-1: subscribeTopicArn đọc TopicArn của link SNS để console hiện (dev kiểm topic có phải của mình)", () => {
    expect(subscribeTopicArn("https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-west-2:123456789012:MyTopic&Token=t")).toBe(
      "arn:aws:sns:us-west-2:123456789012:MyTopic",
    );
    for (const u of ["https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&Token=t", "https://x/?TopicArn=<script>", "không phải url"]) {
      expect([u, subscribeTopicArn(u)]).toEqual([u, null]);
    }
  });

  it("pendingSubscribeUrl + isSnsSubscribeUrl: chỉ https sns.<vùng>.amazonaws.com mới là link SNS thật", () => {
    const url = "https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&Token=t";
    expect(pendingSubscribeUrl([hs("h", { kind: "manual-url", subscribeUrl: url }, "2026-10-13T10:00:01Z")])).toBe(url);
    expect(pendingSubscribeUrl([hs("h", { kind: "manual-url", subscribeUrl: null }, "2026-10-13T10:00:01Z")])).toBeNull();
    expect(isSnsSubscribeUrl(url)).toBe(true);
    expect(isSnsSubscribeUrl("https://sns.cn-north-1.amazonaws.com.cn/?Action=ConfirmSubscription")).toBe(true);
    for (const u of [
      "http://sns.us-west-2.amazonaws.com/?x",
      "https://sns.us-west-2.amazonaws.com.evil.example/?x",
      "https://evil.example/sns.us-west-2.amazonaws.com",
      "https://user:pw@sns.us-west-2.amazonaws.com/",
      "https://sns.us-west-2.amazonaws.com:8443/",
      "https://s3.amazonaws.com/x",
      "javascript:alert(1)",
      "không phải url",
    ]) {
      expect([u, isSnsSubscribeUrl(u)]).toEqual([u, false]);
    }
  });
});

describe("PK4 form tay: khối Bắt tay + Phản hồi dựng đúng khuôn server (validateGenericConfig + parseSourceInput)", () => {
  it("lựa chọn của form = tập của server (kiểu bắt tay, mã ack, khuôn echo, header chung)", () => {
    expect(HANDSHAKE_CHOICES.filter((k) => k !== "none")).toEqual([...HANDSHAKE_KINDS]);
    expect([...ECHO_RESPOND_CHOICES]).toEqual([...ECHO_RESPONDS]);
    expect([...AFTER_VERIFY_CHOICES]).toEqual(["no", "yes"]);
    expect([...COMMON_REQUEST_HEADERS]).toEqual([...SERVER_COMMON_HEADERS]);
    expect([...COMMON_REQUEST_HEADER_PREFIXES]).toEqual([...SERVER_COMMON_PREFIXES]);
    expect(ACK_SUCCESS_CHOICES.map(Number)).toEqual([...ACK_SUCCESS_STATUSES]);
    expect(ACK_REJECT_CHOICES.map(Number)).toEqual([...ACK_REJECT_STATUSES]);
  });

  it("mỗi kiểu bắt tay + ack khác mặc định -> server nhận, round-trip không lệch (verifyToken server tự đổi thành verifyTokenEnc)", () => {
    const forms: GenericFormValues[] = [
      { ...FORM, hsKind: "query-echo", hsParam: "hub.challenge", hsVerifyTokenParam: "hub.verify_token", hsVerifyToken: "my-verify-token", ackReject: "403" },
      { ...FORM, hsKind: "query-echo", hsParam: "challenge" },
      { ...FORM, hsKind: "body-echo", hsWhenName: "type", hsWhenEquals: "url_verification", hsEchoField: "challenge" },
      { ...FORM, hsKind: "body-echo", hsWhenKind: "header", hsWhenName: "Twitch-Eventsub-Message-Type", hsWhenEquals: "webhook_callback_verification", hsEchoField: "challenge" },
      { ...FORM, hsKind: "header-echo", hsHeader: "X-Hook-Secret", ackSuccess: "204" },
      { ...FORM, hsKind: "hmac-echo", hsWhenName: "event", hsWhenEquals: "endpoint.url_validation", hsTokenParent: "payload", hsTokenField: "plainToken", hsMacField: "encryptedToken" },
      { ...FORM, hsKind: "manual-url", hsWhenName: "Type", hsWhenEquals: "SubscriptionConfirmation", hsUrlField: "SubscribeURL", ackSuccess: "202", ackReject: "503" },
      // Sửa review PK4: afterVerify (T-1), respond json + head-ok (ADR-205 bổ sung).
      { ...FORM, hsKind: "body-echo", hsWhenName: "type", hsWhenEquals: "url_verification", hsEchoField: "challenge", hsAfterVerify: "yes", hsRespond: "json" },
      { ...FORM, hsKind: "manual-url", hsWhenName: "Type", hsWhenEquals: "SubscriptionConfirmation", hsUrlField: "SubscribeURL", hsAfterVerify: "yes" },
      { ...FORM, hsKind: "head-ok" },
    ];
    for (const f of forms) {
      expect(genericFormIssues(f, "secret-123456")).toEqual([]);
      const built = buildGenericConfig(f) as Record<string, any>;
      const { verifyToken, ...hsServer } = (built.handshake ?? {}) as Record<string, unknown>;
      if (f.hsVerifyTokenParam) expect(verifyToken).toBe(f.hsVerifyToken);
      const r = validateGenericConfig({ ...built, handshake: { ...hsServer, ...(verifyToken ? { verifyTokenEnc: "enc" } : {}) } });
      expect([f.hsKind, r.ok]).toEqual([f.hsKind, true]);
      const c = (r as { config: GenericConfig }).config;
      expect(c.handshake?.kind).toBe(f.hsKind);
      expect(c.ack ?? {}).toEqual({
        ...(f.ackSuccess !== "200" ? { successStatus: Number(f.ackSuccess) } : {}),
        ...(f.ackReject !== "401" ? { rejectStatus: Number(f.ackReject) } : {}),
      });
    }
    // Mặc định (không bắt tay, 200/401) -> không thêm trường nào (source cũ không đổi khuôn).
    const plain = buildGenericConfig(FORM);
    expect(plain.handshake).toBeUndefined();
    expect(plain.ack).toBeUndefined();
  });

  it("ô sai -> lỗi theo ô, và server cũng từ chối đúng trường đó", () => {
    const cases: [Partial<GenericFormValues>, keyof GenericFormValues, string][] = [
      [{ hsKind: "query-echo", hsParam: "" }, "hsParam", "handshake.param"],
      [{ hsKind: "query-echo", hsParam: "a", hsVerifyTokenParam: "a" }, "hsVerifyTokenParam", "handshake.verifyTokenParam"],
      [{ hsKind: "body-echo", hsWhenName: "a.b", hsWhenEquals: "x", hsEchoField: "c" }, "hsWhenName", "handshake.when.field"],
      [{ hsKind: "body-echo", hsWhenName: "type", hsWhenEquals: "a b", hsEchoField: "c" }, "hsWhenEquals", "handshake.when.equals"],
      [{ hsKind: "body-echo", hsWhenName: "type", hsWhenEquals: "v", hsEchoField: "" }, "hsEchoField", "handshake.echo.field"],
      [{ hsKind: "header-echo", hsHeader: "x y" }, "hsHeader", "handshake.header"],
      [{ hsKind: "hmac-echo", hsWhenName: "event", hsWhenEquals: "v", hsTokenField: "t", hsMacField: "t" }, "hsMacField", "handshake.macField"],
      [{ hsKind: "manual-url", hsWhenName: "Type", hsWhenEquals: "v", hsUrlField: "" }, "hsUrlField", "handshake.urlField"],
      // Review PK4 TB-2: bắt tay trùng header chữ ký / khoá chống trùng / header chung, when.field = trường chống trùng.
      [{ hsKind: "header-echo", hsHeader: "X-Sig" }, "hsHeader", "handshake.header"],
      [{ hsKind: "header-echo", hsHeader: "content-type" }, "hsHeader", "handshake.header"],
      [{ hsKind: "header-echo", hsHeader: "cf-ray" }, "hsHeader", "handshake.header"],
      [{ hsKind: "body-echo", hsWhenKind: "header", hsWhenName: "user-agent", hsWhenEquals: "v", hsEchoField: "c" }, "hsWhenName", "handshake.when.header"],
      [{ hsKind: "body-echo", hsWhenName: "transId", hsWhenEquals: "v", hsEchoField: "c" }, "hsWhenName", "handshake.when.field"],
      [{ hsKind: "manual-url", hsWhenKind: "header", hsWhenName: "x-request-id", hsWhenEquals: "v", hsUrlField: "u", idKind: "header", idValue: "x-request-id" }, "hsWhenName", "handshake.when.header"],
      [{ hsKind: "header-echo", hsHeader: "svix-signature", scheme: "standard-webhooks", idValue: "" }, "hsHeader", "handshake.header"],
    ];
    for (const [patch, path, serverField] of cases) {
      const f = { ...FORM, ...patch };
      expect(genericFormIssues(f, "secret-123456").map((i) => i.path)).toContain(path);
      // parseSourceInput tách verifyToken (rõ) trước validateGenericConfig — làm y hệt.
      const built = buildGenericConfig(f) as Record<string, any>;
      if (built.handshake) delete built.handshake.verifyToken;
      expect((validateGenericConfig(built) as { field?: string }).field).toBe(serverField);
    }
    // Token xác minh: client chặn cùng luật parseSourceInput (8–256, ASCII in được, không dấu cách).
    const vt = { ...FORM, hsKind: "query-echo" as const, hsParam: "hub.challenge", hsVerifyTokenParam: "hub.verify_token" };
    for (const bad of ["short", "has space here", "x".repeat(257)]) expect(genericFormIssues({ ...vt, hsVerifyToken: bad }, "secret-123456").map((i) => i.path)).toContain("hsVerifyToken");
    expect(genericFormIssues({ ...vt, hsVerifyToken: "good-token-1" }, "secret-123456")).toEqual([]);
  });
});

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
      // Review PK2 T-4/T-5/T-6.
      [{ ...FORM, keyEncoding: "base64" }, "AAAAAB=="],
      [{ ...FORM, keyEncoding: "base64" }, "AAAAAA=="],
      [{ ...FORM, keyEncoding: "base64" }, KEY.toString("base64").replace(/=+$/, "")],
      [{ ...FORM, scheme: "static-token", location: "query", param: "token" }, "abc+def/ghi="],
      [{ ...FORM, scheme: "static-token", location: "query", param: "token" }, "A.b_c~d-9"],
      [{ ...FORM, algo: "sha256", prefix: "<algo>=" }, "utf8-secret-123"],
      [{ ...FORM, algo: "sha1", prefix: "<algo>=" }, "utf8-secret-123"],
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

describe("review PK2: T-6 form khớp server", () => {
  it("gõ tay tiền tố `<algo>=` -> không gửi algo (server nhận), như chọn 'Đọc từ tiền tố'", () => {
    const built = buildGenericConfig({ ...FORM, algo: "sha256", prefix: ALGO_IN_PREFIX });
    expect(built).toMatchObject({ prefix: ALGO_IN_PREFIX });
    expect(built).not.toHaveProperty("algo");
    expect(validateGenericConfig(built).ok).toBe(true);
    expect(built).toEqual(buildGenericConfig({ ...FORM, algo: "from-prefix" }));
  });

  it("độ dài khoá bí mật client = server (8–512)", () => {
    expect([SECRET_MIN, SECRET_MAX]).toEqual([8, 512]);
  });
});

describe("PK3: form signed-template — điền nhanh + cùng luật server (validateGenericConfig + secretProblem)", () => {
  const TPL: GenericFormValues = { ...FORM, ...TEMPLATE_PRESETS.slack, idValue: "event_id" };
  const serverIssues = (f: GenericFormValues, secret: string): string[] => {
    const r = validateGenericConfig(buildGenericConfig(f));
    if (!r.ok) return [`config:${(r as { field: string }).field}`];
    const p = secretProblem((r as { config: GenericConfig }).config, secret);
    return p ? ["secret"] : [];
  };

  it.each(Object.keys(TEMPLATE_PRESETS) as TemplatePreset[])("điền nhanh %s -> server nhận đúng điều form gửi, form không báo lỗi", (p) => {
    const f: GenericFormValues = { ...FORM, ...TEMPLATE_PRESETS[p], idValue: "event_id" };
    const built = buildGenericConfig(f);
    const r = validateGenericConfig(built);
    expect({ p, ok: r.ok }).toEqual({ p, ok: true });
    expect((r as unknown as { config: Record<string, unknown> }).config).toMatchObject(built);
    expect(genericFormIssues(f, "secret-pk3-123")).toEqual([]);
  });

  it("Stripe điền nhanh dựng đúng khuôn kv; Slack dựng tiêu đề + tiền tố + timestampHeader", () => {
    expect(buildGenericConfig({ ...FORM, ...TEMPLATE_PRESETS.stripe, idValue: "id" })).toEqual({
      scheme: "signed-template",
      template: "{timestamp}.{body}",
      algo: "sha256",
      encoding: "hex",
      keyEncoding: "utf8",
      signature: { header: "stripe-signature", kv: { sep: ",", sig: "v1", timestamp: "t" } },
      timestampFormat: "unix",
      toleranceSec: 300,
      idempotency: { field: "id" },
      eventType: "acme.invoice.paid",
    });
    expect(buildGenericConfig(TPL)).toMatchObject({ signature: { headers: ["x-slack-signature"], prefix: "v0=" }, timestampHeader: "x-slack-request-timestamp", toleranceSec: 300 });
  });

  it("form lỗi đúng khi và chỉ khi server lỗi", () => {
    const cases: [GenericFormValues, string][] = [
      [TPL, "secret-pk3-123"],
      [{ ...TPL, template: "{timestamp}." }, "secret-pk3-123"],
      [{ ...TPL, template: "{body}{body}" }, "secret-pk3-123"],
      [{ ...TPL, template: "{ts}.{body}" }, "secret-pk3-123"],
      [{ ...TPL, template: `${"x".repeat(128)}{body}` }, "secret-pk3-123"],
      [{ ...TPL, template: "{body}" }, "secret-pk3-123"], // không {timestamp}: ô timestamp bị bỏ qua, server nhận
      [{ ...TPL, toleranceSec: "4" }, "secret-pk3-123"],
      [{ ...TPL, toleranceSec: "901" }, "secret-pk3-123"],
      [{ ...TPL, toleranceSec: "30.5" }, "secret-pk3-123"],
      [{ ...TPL, toleranceSec: "" }, "secret-pk3-123"],
      [{ ...TPL, toleranceSec: "5" }, "secret-pk3-123"],
      [{ ...TPL, timestampHeader: "" }, "secret-pk3-123"],
      [{ ...TPL, template: "{id}{timestamp}{body}" }, "secret-pk3-123"],
      [{ ...TPL, template: "{id}{timestamp}{body}", idHeader: "Twitch-Eventsub-Message-Id" }, "secret-pk3-123"],
      [{ ...TPL, template: "{id}{body}", idHeader: "x-id" }, "secret-pk3-123"], // review PK3 T-1: {id} sát {body}
      [{ ...TPL, template: "{timestamp}.{body}{id}", idHeader: "x-id" }, "secret-pk3-123"],
      [{ ...TPL, template: "{id}.{body}", idHeader: "x-id" }, "secret-pk3-123"],
      [{ ...TPL, algo: "sha1" }, "secret-pk3-123"],
      [{ ...TPL, algo: "from-prefix" }, "secret-pk3-123"],
      [{ ...TPL, header2: "x-slack-signature" }, "secret-pk3-123"],
      [{ ...TPL, header2: "box-signature-secondary" }, "secret-pk3-123"],
      [{ ...TPL, header: "" }, "secret-pk3-123"],
      [{ ...TPL, prefix: "p".repeat(33) }, "secret-pk3-123"],
      [{ ...TPL, keyEncoding: "hex" }, "khong-phai-hex"],
      [{ ...FORM, ...TEMPLATE_PRESETS.stripe, kvSig: "" }, "secret-pk3-123"],
      [{ ...FORM, ...TEMPLATE_PRESETS.stripe, kvSig: "t" }, "secret-pk3-123"],
      [{ ...FORM, ...TEMPLATE_PRESETS.stripe, kvTimestamp: "" }, "secret-pk3-123"], // thời điểm phải ở tiêu đề riêng
      [{ ...FORM, ...TEMPLATE_PRESETS.stripe, kvTimestamp: "", timestampHeader: "x-ts" }, "secret-pk3-123"],
      [{ ...FORM, ...TEMPLATE_PRESETS.paddle, kvSep: ";", template: "{body}" }, "secret-pk3-123"], // không {timestamp}: kv timestamp bỏ qua
      [{ ...TPL, idValue: "" }, "secret-pk3-123"],
    ];
    for (const [f, secret] of cases) {
      const client = genericFormIssues(f, secret).length > 0;
      const server = serverIssues(f, secret).length > 0;
      expect({ f, secret, client }).toEqual({ f, secret, client: server });
    }
  });
});

describe("PK5: form \"Chưa xác thực\" (unverified) — cùng luật server (validateUnverified + parseSourceInput)", () => {
  const U: GenericFormValues = { ...FORM, scheme: "unverified", idValue: "", eventType: "momo.ipn" };
  it("hằng của web = của server (≤ 10 tiêu đề, danh sách cấm, trần 45KB)", () => {
    expect(FORWARD_HEADERS_MAX).toBe(SERVER_FORWARD_MAX);
    expect([...FORWARD_HEADERS_FORBIDDEN]).toEqual([...SERVER_FORWARD_FORBIDDEN]);
    expect(UNVERIFIED_MAX_BODY_KB * 1024).toBe(UNVERIFIED_MAX_BODY_BYTES);
  });
  it("round-trip: form dựng config server nhận nguyên văn (không secret, không header); lỗi form <=> server lỗi", () => {
    const forms: GenericFormValues[] = [
      U,
      { ...U, forwardHeaders: "X-Twilio-Signature, x-request-id", forwardUrl: "yes", idKind: "field", idValue: "transId", ackSuccess: "204" },
      { ...U, idKind: "header", idValue: "X-Id", hsKind: "head-ok" },
    ];
    for (const f of forms) {
      const built = buildGenericConfig(f);
      expect(built).not.toHaveProperty("header");
      const r = validateGenericConfig(built);
      expect({ built, ok: r.ok }).toEqual({ built, ok: true });
      expect((r as unknown as { config: Record<string, unknown> }).config).toEqual(built);
      expect(genericFormIssues(f, "")).toEqual([]);
    }
    const bad: [Partial<GenericFormValues>, string][] = [
      [{ forwardHeaders: "authorization" }, "forwardHeaders"],
      [{ forwardHeaders: "x-hub-signature" }, "forwardHeaders"],
      [{ forwardHeaders: Array.from({ length: 11 }, (_, i) => `x-h${i}`).join(",") }, "forwardHeaders"],
      [{ eventType: "payment.received" }, "eventType"],
      [{ hsKind: "hmac-echo", hsWhenName: "event", hsWhenEquals: "v", hsTokenField: "t", hsMacField: "m" }, "hsKind"],
    ];
    for (const [patch, path] of bad) {
      const f = { ...U, ...patch };
      expect({ patch, client: genericFormIssues(f, "").map((i) => i.path) }).toEqual({ patch, client: expect.arrayContaining([path]) });
      expect({ patch, server: validateGenericConfig(buildGenericConfig(f)).ok }).toEqual({ patch, server: false });
    }
    // Secret: unverified không có khoá bí mật (server 422 secret).
    expect(genericFormIssues(U, "x".repeat(SECRET_MIN)).map((i) => i.issue)).toContain("secret-unverified");
  });
});

describe("[PK:T40] (phần d) form: kiểu khoá chống trùng path / bodyHash khớp server (E31, ADR-230)", () => {
  it("bốn kiểu = IDEMPOTENCY_KINDS của server; luật path là bản sao (đối chiếu từng ca)", () => {
    expect([...ID_KIND_CHOICES].sort()).toEqual([...IDEMPOTENCY_KINDS].sort());
    expect(PATH_SEGMENT_RE.source).toBe(SERVER_PATH_SEGMENT_RE.source);
    expect(PATH_MAX_DEPTH).toBe(SERVER_PATH_MAX_DEPTH);
    for (const p of ["id", "data.id", "webhook_metadata.event.id", "a.b.c.d", "data[0].id", "$.a", "a..b", "", "__proto__.x", "a.constructor", "x-y.z_1"]) {
      expect({ p, web: isIdempotencyPath(p) }).toEqual({ p, web: idempotencyPathProblem(p) === null });
    }
  });

  it("buildGenericConfig: path -> {path}; bodyHash -> {bodyHash:true} (bỏ qua ô tên); server nhận nguyên khuôn mọi scheme có nghĩa", () => {
    const forms: GenericFormValues[] = [
      { ...FORM, idKind: "path", idValue: " webhook_metadata.event.id " },
      { ...FORM, idKind: "bodyHash", idValue: "bất kỳ" },
      { ...FORM, scheme: "static-token", header: "x-token", idKind: "bodyHash", idValue: "" },
      { ...FORM, ...UNVERIFIED_FORM_DEFAULTS, scheme: "unverified", idKind: "path", idValue: "data.id" },
    ];
    for (const f of forms) {
      const built = buildGenericConfig(f);
      const r = validateGenericConfig(built);
      expect({ f: f.idKind, ok: r.ok }).toEqual({ f: f.idKind, ok: true });
      expect((r as unknown as { config: Record<string, unknown> }).config).toMatchObject(built);
    }
    expect(buildGenericConfig(forms[0]).idempotency).toEqual({ path: "webhook_metadata.event.id" });
    expect(buildGenericConfig(forms[1]).idempotency).toEqual({ bodyHash: true });
    expect(idempotencyOf({ scheme: "standard-webhooks", idKind: "bodyHash", idValue: "" })).toBeNull(); // sw luôn theo tiêu đề
  });

  it("genericFormIssues: path vượt 3 cấp / sai khuôn -> id-path-invalid (server cũng 422 idempotency.path); bodyHash không đòi ô tên", () => {
    for (const p of ["a.b.c.d", "data[0].id", "$.x"]) {
      const f = { ...FORM, idKind: "path" as const, idValue: p };
      expect(genericFormIssues(f, "secret_value_x")).toContainEqual({ path: "idValue", issue: "id-path-invalid" });
      expect((validateGenericConfig(buildGenericConfig(f)) as { field?: string }).field).toBe("idempotency.path");
    }
    expect(genericFormIssues({ ...FORM, idKind: "bodyHash", idValue: "" }, "secret_value_x")).toEqual([]);
    expect(genericFormIssues({ ...FORM, idKind: "path", idValue: "data.id" }, "secret_value_x")).toEqual([]);
  });

  it("bắt tay when.field trùng cấp đầu của path -> hs-conflict (như server)", () => {
    const f = { ...FORM, idKind: "path" as const, idValue: "data.id", hsKind: "body-echo" as const, hsWhenKind: "field" as const, hsWhenName: "data", hsWhenEquals: "url_verification", hsEchoField: "challenge" };
    expect(genericFormIssues(f, "secret_value_x")).toContainEqual({ path: "hsWhenName", issue: "hs-conflict" });
  });

  it("chẩn đoán empty_body có câu riêng (không rơi về unknown)", () => {
    expect(LISTEN_REASON_KEYS.empty_body).toBe("page.sources.listen.reason.empty-body");
  });
});
