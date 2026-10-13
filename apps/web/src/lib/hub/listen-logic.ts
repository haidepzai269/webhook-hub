// PK1 (SPEC-provider-khac §3, ADR-202): logic thuần của tab "Lắng nghe" và form tay "Nhà cung cấp khác" (generic).
// Không import React — test bằng jest ở gốc repo.

/** Chẩn đoán của adapter (khuôn `Diagnosis` của @hub/providers) — chỉ TÊN header/trường, không bao giờ giá trị. */
export interface InspectDiagnosis {
  ok: boolean;
  reason?: string;
  expectedHeader?: string;
  expectedField?: string;
  candidateHeaders?: string[];
  field?: string;
  /** PK2: tên tham số query chứa token (giá trị không bao giờ được lưu). */
  expectedQueryParam?: string;
  /** Review PK3 T-6: tên khoá thiếu trong tiêu đề khoá=giá trị (vd `t` của `stripe-signature`). */
  expectedKvKey?: string;
}

/** PK4 (ADR-205): dòng bắt tay — `kind`, và với `manual-url` thì `subscribeUrl` (link SNS cho dev tự bấm). */
export interface InspectHandshake {
  kind: string;
  subscribeUrl?: string | null;
}

/** Một dòng của `GET /api/v1/sources/:id/inspect` (cùng khuôn `GET /v1/p/:project/sources/:id/inspect`). */
export interface InspectRow {
  id: string;
  receivedAt: string;
  status: string;
  diagnosis: InspectDiagnosis;
  /** PK4: chỉ có ở dòng bắt tay (REJECTED + `diagnosis.reason = "handshake"`). */
  handshake?: InspectHandshake;
}

export type ConnectionState =
  | { kind: "waiting" }
  | { kind: "handshaken"; handshake: InspectHandshake }
  | { kind: "connected"; lastFailure: InspectDiagnosis | null; handshake: InspectHandshake | null }
  | { kind: "failing"; diagnosis: InspectDiagnosis };

/** PK4: dòng REJECTED của bắt tay KHÔNG phải trượt (E8) — nó là "đã bắt tay". */
const isHandshakeRow = (r: InspectRow) => r.diagnosis?.reason === "handshake";

/**
 * Dòng trạng thái kết nối (SPEC §3.3). `rows` mới nhất trước (như API trả).
 * - Có ACCEPTED nào -> "Đã nhận request đầu tiên ✓" (request thật đã vào; lỗi ánh xạ sau đó vẫn là đã nối được).
 *   Request mới nhất mà trượt thì kèm `lastFailure` để dev thấy.
 * - PK4: chưa ACCEPTED, request REJECTED mới nhất là bắt tay -> "Đã bắt tay với nhà cung cấp ✓" (kèm SubscribeURL nếu có).
 * - Không ACCEPTED, có REJECTED (không phải bắt tay) mới hơn -> "Trượt: …" theo REJECTED gần nhất.
 * - Còn lại (rỗng, chỉ DUPLICATE) -> chờ.
 */
export function connectionState(rows: InspectRow[] | undefined): ConnectionState {
  const list = rows ?? [];
  const hsRow = list.find(isHandshakeRow);
  const handshake = hsRow ? (hsRow.handshake ?? { kind: "unknown" }) : null;
  if (list.some((r) => r.status === "ACCEPTED")) {
    const latest = list[0];
    return { kind: "connected", lastFailure: latest?.status === "REJECTED" && !isHandshakeRow(latest) ? latest.diagnosis : null, handshake };
  }
  const rejected = list.find((r) => r.status === "REJECTED");
  if (rejected && isHandshakeRow(rejected)) return { kind: "handshaken", handshake: handshake! };
  if (rejected) return { kind: "failing", diagnosis: rejected.diagnosis };
  return { kind: "waiting" };
}

/** PK4: dòng bắt tay `manual-url` gần nhất còn link SubscribeURL (null nếu không có). */
export function pendingSubscribeUrl(rows: InspectRow[] | undefined): string | null {
  const r = (rows ?? []).find((x) => x.handshake?.kind === "manual-url" && typeof x.handshake.subscribeUrl === "string");
  return r?.handshake?.subscribeUrl ?? null;
}

/**
 * PK4 (§6.1, §15): hub KHÔNG gọi SubscribeURL (SSRF) — console chỉ hiện link cho dev tự bấm. Chỉ coi là link SNS thật khi
 * https và tên miền `sns.<vùng>.amazonaws.com` (hoặc `.amazonaws.com.cn`); ngoài ra console cảnh báo, không làm link.
 */
export function isSnsSubscribeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname) && u.port === "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Tách chẩn đoán thành lý do + tên header/trường để dựng câu i18n. Không có lý do -> "unknown". */
export function diagnosisParts(d: InspectDiagnosis): { reason: string; name: string | null; candidates: string[] } {
  return {
    reason: d.reason ?? "unknown",
    name: d.expectedKvKey
      ? `${d.expectedKvKey} (${d.expectedHeader ?? ""})`
      : (d.expectedHeader ?? d.expectedField ?? d.field ?? (d.expectedQueryParam ? `?${d.expectedQueryParam}` : null)),
    candidates: d.candidateHeaders ?? [],
  };
}

/**
 * Mẫu xác thực mà form tay đưa ra. PK2 (ADR-203): `hmac` có tham số; bí danh cũ `hmac-sha256` chỉ còn cho source đã tạo
 * (server vẫn nhận), form không tạo mới bằng nó.
 */
export const GENERIC_SCHEMES = ["hmac", "signed-template", "static-token", "standard-webhooks"] as const;
export type GenericScheme = (typeof GENERIC_SCHEMES)[number];
/** `from-prefix` = chữ ký dạng `<algo>=<sig>` (Bitbucket, Jira, WebSub) -> `prefix: "<algo>="`, không gửi `algo`. */
export const HMAC_ALGO_CHOICES = ["sha256", "sha512", "sha1", "from-prefix"] as const;
export const KEY_ENCODING_CHOICES = ["utf8", "hex", "base64"] as const;
export const TOKEN_LOCATION_CHOICES = ["header", "basic", "query"] as const;
/** PK3: `signed-template` chỉ sha256 | sha512 (như `TEMPLATE_ALGOS` của server). */
export const TEMPLATE_ALGO_CHOICES = ["sha256", "sha512"] as const;
export const SIG_MODE_CHOICES = ["headers", "kv"] as const;
export const KV_SEP_CHOICES = [",", ";"] as const;
export const TIMESTAMP_FORMAT_CHOICES = ["unix", "unix-ms", "iso8601"] as const;
/** Giống `ALGO_IN_PREFIX` của @hub/providers (test so). */
export const ALGO_IN_PREFIX = "<algo>=";

/** PK4 (§6.1, ADR-205): kiểu bắt tay — `none` = không khai. Cùng tập `HANDSHAKE_KINDS` của server (test đối chiếu). */
export const HANDSHAKE_CHOICES = ["none", "query-echo", "body-echo", "header-echo", "hmac-echo", "manual-url"] as const;
export const WHEN_KIND_CHOICES = ["field", "header"] as const;
/** PK4 §6.3: mã HTTP của ack (chuỗi trong form). Từ chối KHÔNG có 2xx. */
export const ACK_SUCCESS_CHOICES = ["200", "202", "204"] as const;
export const ACK_REJECT_CHOICES = ["401", "403", "503"] as const;

export interface GenericFormValues {
  scheme: GenericScheme;
  header: string;
  encoding: "hex" | "base64";
  algo: (typeof HMAC_ALGO_CHOICES)[number];
  prefix: string;
  keyEncoding: (typeof KEY_ENCODING_CHOICES)[number];
  location: (typeof TOKEN_LOCATION_CHOICES)[number];
  param: string;
  idKind: "header" | "field";
  idValue: string;
  eventType: string;
  // PK3 (SPEC-provider-khac §5, E16, ADR-204): `signed-template`. `header` = tiêu đề chữ ký (kv: tiêu đề khoá=giá trị),
  // `prefix` = tiền tố chữ ký (chế độ tiêu đề), `algo`/`encoding`/`keyEncoding` dùng chung với hmac.
  template: string;
  sigMode: (typeof SIG_MODE_CHOICES)[number];
  header2: string;
  kvSep: (typeof KV_SEP_CHOICES)[number];
  kvSig: string;
  kvTimestamp: string;
  timestampHeader: string;
  timestampFormat: (typeof TIMESTAMP_FORMAT_CHOICES)[number];
  idHeader: string;
  /** Chuỗi của ô số (form giữ chuỗi; dựng config thì đổi sang số). */
  toleranceSec: string;
  // PK4 (§6, ADR-205): bắt tay + phản hồi.
  hsKind: (typeof HANDSHAKE_CHOICES)[number];
  /** query-echo: tham số mang challenge (`hub.challenge`, `challenge`). */
  hsParam: string;
  /** query-echo: tham số mang token xác minh (tuỳ chọn, `hub.verify_token`). */
  hsVerifyTokenParam: string;
  /** query-echo: token xác minh bạn khai ở nhà cung cấp — server mã hoá, không bao giờ trả lại. */
  hsVerifyToken: string;
  hsWhenKind: (typeof WHEN_KIND_CHOICES)[number];
  hsWhenName: string;
  hsWhenEquals: string;
  /** body-echo: trường trả lại. */
  hsEchoField: string;
  /** header-echo: tiêu đề trả lại. */
  hsHeader: string;
  /** hmac-echo: trường chứa token (+ trường cha, một cấp) và tên trường chứa HMAC trả về. */
  hsTokenParent: string;
  hsTokenField: string;
  hsMacField: string;
  /** manual-url: trường chứa link xác nhận (SNS `SubscribeURL`). */
  hsUrlField: string;
  ackSuccess: (typeof ACK_SUCCESS_CHOICES)[number];
  ackReject: (typeof ACK_REJECT_CHOICES)[number];
}

/** PK4: giá trị mặc định của các ô bắt tay / phản hồi (không bắt tay; 200 / 401 như trước PK4). */
export const HANDSHAKE_FORM_DEFAULTS: Pick<
  GenericFormValues,
  | "hsKind"
  | "hsParam"
  | "hsVerifyTokenParam"
  | "hsVerifyToken"
  | "hsWhenKind"
  | "hsWhenName"
  | "hsWhenEquals"
  | "hsEchoField"
  | "hsHeader"
  | "hsTokenParent"
  | "hsTokenField"
  | "hsMacField"
  | "hsUrlField"
  | "ackSuccess"
  | "ackReject"
> = {
  hsKind: "none",
  hsParam: "",
  hsVerifyTokenParam: "",
  hsVerifyToken: "",
  hsWhenKind: "field",
  hsWhenName: "",
  hsWhenEquals: "",
  hsEchoField: "",
  hsHeader: "",
  hsTokenParent: "",
  hsTokenField: "",
  hsMacField: "",
  hsUrlField: "",
  ackSuccess: "200",
  ackReject: "401",
};

/** Giá trị mặc định của các ô `signed-template` (trang tạo nguồn dùng làm defaultValues). */
export const TEMPLATE_FORM_DEFAULTS: Pick<
  GenericFormValues,
  "template" | "sigMode" | "header2" | "kvSep" | "kvSig" | "kvTimestamp" | "timestampHeader" | "timestampFormat" | "idHeader" | "toleranceSec"
> = { template: "", sigMode: "headers", header2: "", kvSep: ",", kvSig: "", kvTimestamp: "", timestampHeader: "", timestampFormat: "unix", idHeader: "", toleranceSec: "300" };

/**
 * PK3: điền nhanh — CHỈ là giá trị điền sẵn cho các ô ký theo tài liệu công khai của từng bên (không phải danh mục, không
 * nhận diện, không khoá chống trùng/kiểu sự kiện). Dev vẫn thấy và sửa được mọi ô; server kiểm lại như form tay.
 */
export const TEMPLATE_PRESETS = {
  stripe: { scheme: "signed-template", template: "{timestamp}.{body}", algo: "sha256", encoding: "hex", keyEncoding: "utf8", sigMode: "kv", header: "stripe-signature", header2: "", prefix: "", kvSep: ",", kvSig: "v1", kvTimestamp: "t", timestampHeader: "", timestampFormat: "unix", idHeader: "", toleranceSec: "300" },
  slack: { scheme: "signed-template", template: "v0:{timestamp}:{body}", algo: "sha256", encoding: "hex", keyEncoding: "utf8", sigMode: "headers", header: "x-slack-signature", header2: "", prefix: "v0=", kvSep: ",", kvSig: "", kvTimestamp: "", timestampHeader: "x-slack-request-timestamp", timestampFormat: "unix", idHeader: "", toleranceSec: "300" },
  paddle: { scheme: "signed-template", template: "{timestamp}:{body}", algo: "sha256", encoding: "hex", keyEncoding: "utf8", sigMode: "kv", header: "paddle-signature", header2: "", prefix: "", kvSep: ";", kvSig: "h1", kvTimestamp: "ts", timestampHeader: "", timestampFormat: "unix", idHeader: "", toleranceSec: "5" },
} as const satisfies Record<string, Partial<GenericFormValues>>;
export type TemplatePreset = keyof typeof TEMPLATE_PRESETS;

/** Template (đã trim) dùng token nào. */
const templateHas = (v: Pick<GenericFormValues, "template">, token: "timestamp" | "id") => v.template.includes(`{${token}}`);
/** Timestamp nằm trong header khoá=giá trị (Stripe `t`, Paddle `ts`) thay vì tiêu đề riêng. */
const kvTimestampOf = (v: Pick<GenericFormValues, "sigMode" | "kvTimestamp">) => (v.sigMode === "kv" ? v.kvTimestamp.trim() : "");

/** Ô "tiêu đề chứa chữ ký / token" có dùng không (standard-webhooks đọc bộ cố định; basic dùng Authorization; query không có). */
export const needsHeader = (v: Pick<GenericFormValues, "scheme" | "location">): boolean =>
  v.scheme === "hmac" || v.scheme === "signed-template" || (v.scheme === "static-token" && v.location === "header");
/** Ô tiền tố tĩnh có dùng không (signed-template: chỉ khi chữ ký nằm nguyên trong tiêu đề, không phải khoá=giá trị). */
export const needsPrefix = (v: Pick<GenericFormValues, "scheme" | "location" | "algo" | "sigMode">): boolean =>
  needsHeader(v) && !(v.scheme === "hmac" && v.algo === "from-prefix") && !(v.scheme === "signed-template" && v.sigMode === "kv");
/**
 * Review PK2 T-6: thuật toán đọc từ tiền tố — chọn "Đọc từ tiền tố" HOẶC gõ tay đúng `<algo>=` vào ô tiền tố. Khi đó form ẩn
 * ô thuật toán và KHÔNG gửi `algo` (server từ chối `algo` đi cùng `"<algo>="`).
 */
export const algoFromPrefix = (v: Pick<GenericFormValues, "scheme" | "algo" | "prefix">): boolean =>
  v.scheme === "hmac" && (v.algo === "from-prefix" || v.prefix === ALGO_IN_PREFIX);

/**
 * Review PK1 T-1: standard-webhooks lấy khoá chống trùng từ TIÊU ĐỀ (id của bộ header đang dùng, đã được ký) — không có
 * lựa chọn "trường body". Form ẩn ô chọn và dùng hàm này để biết loại khoá thật.
 */
export const idKindOf = (v: Pick<GenericFormValues, "scheme" | "idKind">): "header" | "field" =>
  v.scheme === "standard-webhooks" ? "header" : v.idKind;

/**
 * Form tay (trước PK7) -> `verificationConfig` đúng khuôn `validateGenericConfig` (server vẫn kiểm lại, 422 có tên trường).
 * Header viết thường (HTTP không phân biệt hoa thường). standard-webhooks không có header/encoding; khoá chống trùng bỏ
 * trống = id của bộ header (`webhook-id` / `svix-id`).
 */
export function buildGenericConfig(v: GenericFormValues): Record<string, unknown> {
  const config: Record<string, unknown> = { scheme: v.scheme };
  if (v.scheme === "signed-template") return withHandshakeAck(v, buildTemplateConfig(v, config));
  if (needsHeader(v)) config.header = v.header.trim().toLowerCase();
  if (v.scheme === "hmac") {
    // PK2: tham số HMAC. "Đọc từ tiền tố" -> prefix "<algo>=", không có algo.
    config.encoding = v.encoding;
    config.keyEncoding = v.keyEncoding;
    if (algoFromPrefix(v)) config.prefix = ALGO_IN_PREFIX;
    else config.algo = v.algo;
  }
  if (v.scheme === "static-token" && v.location !== "header") {
    config.location = v.location;
    if (v.location === "query") config.param = v.param.trim();
  }
  // Tiền tố KHÔNG trim (vd "Bearer " có dấu cách thật); rỗng = không có. `<algo>=` gõ tay đã xử lý ở trên.
  if (needsPrefix(v) && v.prefix !== "" && !algoFromPrefix(v)) config.prefix = v.prefix;
  const idValue = v.idValue.trim();
  if (idValue) config.idempotency = idKindOf(v) === "header" ? { header: idValue.toLowerCase() } : { field: idValue };
  config.eventType = v.eventType.trim();
  return withHandshakeAck(v, config);
}

/**
 * PK4 (§6.1/§6.3, ADR-205): `handshake` theo kiểu đã chọn + `ack` khi khác mặc định (200 / 401). `verifyToken` gửi RÕ một lần
 * lúc tạo — server mã hoá thành `verifyTokenEnc` (E13), không bao giờ trả lại.
 */
export function buildHandshake(v: GenericFormValues): Record<string, unknown> | null {
  const when = () =>
    v.hsWhenKind === "header" ? { header: v.hsWhenName.trim().toLowerCase(), equals: v.hsWhenEquals.trim() } : { field: v.hsWhenName.trim(), equals: v.hsWhenEquals.trim() };
  switch (v.hsKind) {
    case "query-echo": {
      const vtp = v.hsVerifyTokenParam.trim();
      return { kind: v.hsKind, param: v.hsParam.trim(), ...(vtp ? { verifyTokenParam: vtp, verifyToken: v.hsVerifyToken } : {}) };
    }
    case "body-echo":
      return { kind: v.hsKind, when: when(), echo: { field: v.hsEchoField.trim() } };
    case "header-echo":
      return { kind: v.hsKind, header: v.hsHeader.trim().toLowerCase() };
    case "hmac-echo": {
      const parent = v.hsTokenParent.trim();
      return { kind: v.hsKind, when: when(), ...(parent ? { tokenParent: parent } : {}), tokenField: v.hsTokenField.trim(), macField: v.hsMacField.trim() };
    }
    case "manual-url":
      return { kind: v.hsKind, when: when(), urlField: v.hsUrlField.trim() };
    default:
      return null;
  }
}

function withHandshakeAck(v: GenericFormValues, config: Record<string, unknown>): Record<string, unknown> {
  const hs = buildHandshake(v);
  if (hs) config.handshake = hs;
  const ack: Record<string, number> = {};
  if (v.ackSuccess !== "200") ack.successStatus = Number(v.ackSuccess);
  if (v.ackReject !== "401") ack.rejectStatus = Number(v.ackReject);
  if (Object.keys(ack).length > 0) config.ack = ack;
  return config;
}

/** PK3: `signed-template` — chỉ gửi trường timestamp khi template có `{timestamp}`, `idHeader` khi có `{id}` (đúng luật server). */
function buildTemplateConfig(v: GenericFormValues, config: Record<string, unknown>): Record<string, unknown> {
  const header = v.header.trim().toLowerCase();
  config.template = v.template.trim();
  config.algo = v.algo;
  config.encoding = v.encoding;
  config.keyEncoding = v.keyEncoding;
  const hasTs = templateHas(v, "timestamp");
  const kvTs = hasTs ? kvTimestampOf(v) : "";
  if (v.sigMode === "kv") {
    config.signature = { header, kv: { sep: v.kvSep, sig: v.kvSig.trim(), ...(kvTs ? { timestamp: kvTs } : {}) } };
  } else {
    const headers = [header, v.header2.trim().toLowerCase()].filter((h) => h !== "");
    config.signature = { headers, ...(v.prefix !== "" ? { prefix: v.prefix } : {}) };
  }
  if (hasTs) {
    if (!kvTs) config.timestampHeader = v.timestampHeader.trim().toLowerCase();
    config.timestampFormat = v.timestampFormat;
    config.toleranceSec = Number(v.toleranceSec.trim());
  }
  if (templateHas(v, "id")) config.idHeader = v.idHeader.trim().toLowerCase();
  const idValue = v.idValue.trim();
  if (idValue) config.idempotency = idKindOf(v) === "header" ? { header: idValue.toLowerCase() } : { field: idValue };
  config.eventType = v.eventType.trim();
  return config;
}

/**
 * Review PK1 T-2: không gian tên của kiểu chuẩn (`payment.*`, `repo.*`, `hub.*`) — BẢN SAO của `RESERVED_NAMESPACES`
 * (`libs/common/src/canonical/index.ts`, E24): web chưa alias `@hub/common`, và barrel đó kéo theo validator không cần ở
 * client. Test `listen-logic.spec.ts` so bản sao với bản gốc — lệch là đỏ. Server vẫn là trọng tài (422 "cần mapping").
 */
export const RESERVED_NAMESPACES = ["payment", "repo", "hub"] as const;
export function isReservedType(type: string): boolean {
  return RESERVED_NAMESPACES.some((ns) => type === ns || type.startsWith(`${ns}.`));
}

const HEADER_RE = /^[a-z0-9-]{1,64}$/;
const FIELD_RE = /^[A-Za-z0-9_]{1,64}$/;
const PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const EVENT_TYPE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const HEX_KEY_RE = /^(?:[0-9a-fA-F]{2})+$/;
const B64_KEY_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/;
/** Review PK2 T-5: token ở query chỉ gồm ký tự không cần mã hoá URL (như `QUERY_TOKEN_RE` của server). */
const QUERY_TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
/** Review PK2 T-6: độ dài khoá bí mật như server (`parseSourceInput`: 8–512) — mọi nhà cung cấp. */
export const SECRET_MIN = 8;
export const SECRET_MAX = 512;
/** Review PK2 T-4: base64 khứ hồi (bit thừa khác 0 bị từ chối) — như `decodeHmacKey` của server. */
function isCanonicalBase64(s: string): boolean {
  if (s.length === 0 || !B64_KEY_RE.test(s)) return false;
  const bin = atob(s.replace(/=+$/, "").padEnd(Math.ceil(s.replace(/=+$/, "").length / 4) * 4, "="));
  return btoa(bin).replace(/=+$/, "") === s.replace(/=+$/, "");
}
/** PK3: như `TEMPLATE_RE` / `KV_KEY_RE` / `TOLERANCE_*` của server (test đối chiếu). */
const TEMPLATE_RE = /^([^{}]|\{(timestamp|body|id)\}){1,128}$/;
const KV_KEY_RE = /^[A-Za-z0-9_]{1,16}$/;
const TOLERANCE_RE = /^\d{1,3}$/;
export const TOLERANCE_MIN_SEC = 5;
export const TOLERANCE_MAX_SEC = 900;
/** E15: tiền tố ≤ 32 ký tự (như server). */
export const PREFIX_MAX = 32;

export type GenericFormIssue =
  | "header-required"
  | "prefix-too-long"
  | "param-required"
  | "id-required"
  | "event-type-invalid"
  | "event-type-reserved"
  | "secret-hex"
  | "secret-base64"
  | "secret-basic"
  | "secret-query"
  | "template-invalid"
  | "algo-template"
  | "header2-invalid"
  | "kv-key-invalid"
  | "timestamp-header-required"
  | "tolerance-invalid"
  | "id-header-required"
  | "hs-param-invalid"
  | "hs-verify-token-invalid"
  | "hs-when-invalid"
  | "hs-field-invalid"
  | "hs-header-invalid";

/** PK4: như `WHEN_EQUALS_RE` / `VERIFY_TOKEN_RE` / echo của server (test đối chiếu). */
const WHEN_EQUALS_RE = /^[\x21-\x7E]{1,128}$/;
const VERIFY_TOKEN_RE = /^[\x21-\x7E]{8,256}$/;

/**
 * PK2: kiểm form tay theo CÙNG luật server (`validateGenericConfig` + `secretProblem` của @hub/providers) — test
 * `listen-logic.spec.ts` đối chiếu từng ca với server. Server vẫn là trọng tài (422 có tên trường).
 */
export function genericFormIssues(v: GenericFormValues, secret: string): { path: keyof GenericFormValues | "secret"; issue: GenericFormIssue }[] {
  const out: { path: keyof GenericFormValues | "secret"; issue: GenericFormIssue }[] = [];
  if (needsHeader(v) && !HEADER_RE.test(v.header.trim().toLowerCase())) out.push({ path: "header", issue: "header-required" });
  if (needsPrefix(v) && v.prefix.length > PREFIX_MAX) out.push({ path: "prefix", issue: "prefix-too-long" });
  if (v.scheme === "static-token" && v.location === "query" && !PARAM_RE.test(v.param.trim())) out.push({ path: "param", issue: "param-required" });
  const id = v.idValue.trim();
  const idOk = idKindOf(v) === "header" ? HEADER_RE.test(id.toLowerCase()) : FIELD_RE.test(id);
  if ((id || v.scheme !== "standard-webhooks") && !idOk) out.push({ path: "idValue", issue: "id-required" });
  const eventType = v.eventType.trim();
  if (!EVENT_TYPE_RE.test(eventType) || eventType.length > 128) out.push({ path: "eventType", issue: "event-type-invalid" });
  // Review PK1 T-2: kiểu chuẩn cần ánh xạ trường (PK7 / API) — form tay không có ô mapping, server sẽ 422.
  else if (isReservedType(eventType)) out.push({ path: "eventType", issue: "event-type-reserved" });
  if (v.scheme === "signed-template") out.push(...templateIssues(v));
  const keyed = v.scheme === "hmac" || v.scheme === "signed-template";
  if (keyed && v.keyEncoding === "hex" && !HEX_KEY_RE.test(secret)) out.push({ path: "secret", issue: "secret-hex" });
  if (keyed && v.keyEncoding === "base64" && !isCanonicalBase64(secret)) out.push({ path: "secret", issue: "secret-base64" });
  if (v.scheme === "static-token" && v.location === "basic" && !secret.includes(":")) out.push({ path: "secret", issue: "secret-basic" });
  if (v.scheme === "static-token" && v.location === "query" && !QUERY_TOKEN_RE.test(secret)) out.push({ path: "secret", issue: "secret-query" });
  out.push(...handshakeIssues(v));
  return out;
}

/** PK4: luật `handshake` của server (`parseHandshake` + `parseSourceInput`) cho các ô form. */
function handshakeIssues(v: GenericFormValues): { path: keyof GenericFormValues; issue: GenericFormIssue }[] {
  const out: { path: keyof GenericFormValues; issue: GenericFormIssue }[] = [];
  const field = (path: keyof GenericFormValues, value: string) => {
    if (!FIELD_RE.test(value.trim())) out.push({ path, issue: "hs-field-invalid" });
  };
  const when = () => {
    const name = v.hsWhenName.trim();
    if (!(v.hsWhenKind === "header" ? HEADER_RE.test(name.toLowerCase()) : FIELD_RE.test(name))) out.push({ path: "hsWhenName", issue: "hs-when-invalid" });
    if (!WHEN_EQUALS_RE.test(v.hsWhenEquals.trim())) out.push({ path: "hsWhenEquals", issue: "hs-when-invalid" });
  };
  if (v.hsKind === "query-echo") {
    const param = v.hsParam.trim();
    const vtp = v.hsVerifyTokenParam.trim();
    if (!PARAM_RE.test(param)) out.push({ path: "hsParam", issue: "hs-param-invalid" });
    if (vtp !== "" && (!PARAM_RE.test(vtp) || vtp === param)) out.push({ path: "hsVerifyTokenParam", issue: "hs-param-invalid" });
    if (vtp !== "" && !VERIFY_TOKEN_RE.test(v.hsVerifyToken)) out.push({ path: "hsVerifyToken", issue: "hs-verify-token-invalid" });
  } else if (v.hsKind === "body-echo") {
    when();
    field("hsEchoField", v.hsEchoField);
  } else if (v.hsKind === "header-echo") {
    if (!HEADER_RE.test(v.hsHeader.trim().toLowerCase())) out.push({ path: "hsHeader", issue: "hs-header-invalid" });
  } else if (v.hsKind === "hmac-echo") {
    when();
    if (v.hsTokenParent.trim() !== "") field("hsTokenParent", v.hsTokenParent);
    field("hsTokenField", v.hsTokenField);
    field("hsMacField", v.hsMacField);
    if (v.hsMacField.trim() !== "" && v.hsMacField.trim() === v.hsTokenField.trim()) out.push({ path: "hsMacField", issue: "hs-field-invalid" });
  } else if (v.hsKind === "manual-url") {
    when();
    field("hsUrlField", v.hsUrlField);
  }
  return out;
}

/** PK3: luật `signed-template` của server (`validateSignedTemplate`) cho các ô form. */
function templateIssues(v: GenericFormValues): { path: keyof GenericFormValues; issue: GenericFormIssue }[] {
  const out: { path: keyof GenericFormValues; issue: GenericFormIssue }[] = [];
  const template = v.template.trim();
  // Review PK3 T-1: `{id}` sát `{body}` -> 422 `template` ở server (dời byte qua ranh giới), client cùng luật.
  const idTouchesBody = template.includes("{id}{body}") || template.includes("{body}{id}");
  if (!TEMPLATE_RE.test(template) || template.split("{body}").length !== 2 || idTouchesBody) out.push({ path: "template", issue: "template-invalid" });
  if (!(TEMPLATE_ALGO_CHOICES as readonly string[]).includes(v.algo)) out.push({ path: "algo", issue: "algo-template" });
  const h2 = v.header2.trim().toLowerCase();
  if (v.sigMode === "headers" && h2 !== "" && (!HEADER_RE.test(h2) || h2 === v.header.trim().toLowerCase())) out.push({ path: "header2", issue: "header2-invalid" });
  const hasTs = templateHas(v, "timestamp");
  if (v.sigMode === "kv") {
    if (!KV_KEY_RE.test(v.kvSig.trim())) out.push({ path: "kvSig", issue: "kv-key-invalid" });
    const ts = kvTimestampOf(v);
    if (hasTs && ts !== "" && (!KV_KEY_RE.test(ts) || ts === v.kvSig.trim())) out.push({ path: "kvTimestamp", issue: "kv-key-invalid" });
  }
  if (hasTs) {
    if (kvTimestampOf(v) === "" && !HEADER_RE.test(v.timestampHeader.trim().toLowerCase())) out.push({ path: "timestampHeader", issue: "timestamp-header-required" });
    const tol = v.toleranceSec.trim();
    if (!TOLERANCE_RE.test(tol) || Number(tol) < TOLERANCE_MIN_SEC || Number(tol) > TOLERANCE_MAX_SEC) out.push({ path: "toleranceSec", issue: "tolerance-invalid" });
  }
  if (templateHas(v, "id") && !HEADER_RE.test(v.idHeader.trim().toLowerCase())) out.push({ path: "idHeader", issue: "id-header-required" });
  return out;
}

/** Nhịp poll của tab Lắng nghe. */
export const LISTEN_REFRESH_MS = 2000;

/**
 * Review PK1 T-5: nhịp poll theo lỗi gần nhất. 404 (nguồn bị lưu trữ / không còn thuộc project) -> dừng hẳn; lỗi khác
 * (mạng chập chờn) -> poll tiếp, bảng cũ vẫn giữ.
 */
export function listenRefetchInterval(error: unknown): number | false {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return status === 404 ? false : LISTEN_REFRESH_MS;
}

/**
 * Review PK1 TB-1: Playground chỉ ký được theo khuôn CỐ ĐỊNH của provider native. Nguồn "Nhà cung cấp khác" (generic) có
 * cấu hình riêng (scheme/header/encoding…) mà Playground chưa ký theo — để trong danh sách thì luôn 401 và dev tưởng
 * cấu hình sai. Lọc ra tới PK7; trang hiện một dòng chỉ sang tab Lắng nghe / `hub trigger`.
 */
export function playgroundSources<T extends { provider: string }>(sources: readonly T[] | undefined): { usable: T[]; hiddenGeneric: number } {
  const list = sources ?? [];
  const usable = list.filter((s) => s.provider !== "generic");
  return { usable, hiddenGeneric: list.length - usable.length };
}
