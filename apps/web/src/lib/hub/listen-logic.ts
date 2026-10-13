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
}

/** Một dòng của `GET /api/v1/sources/:id/inspect` (cùng khuôn `GET /v1/p/:project/sources/:id/inspect`). */
export interface InspectRow {
  id: string;
  receivedAt: string;
  status: string;
  diagnosis: InspectDiagnosis;
}

export type ConnectionState =
  | { kind: "waiting" }
  | { kind: "connected"; lastFailure: InspectDiagnosis | null }
  | { kind: "failing"; diagnosis: InspectDiagnosis };

/**
 * Dòng trạng thái kết nối (SPEC §3.3). `rows` mới nhất trước (như API trả).
 * - Có ACCEPTED nào -> "Đã nhận request đầu tiên ✓" (request thật đã vào; lỗi ánh xạ sau đó vẫn là đã nối được).
 *   Request mới nhất mà trượt thì kèm `lastFailure` để dev thấy.
 * - Không ACCEPTED, có REJECTED -> "Trượt: …" theo REJECTED gần nhất.
 * - Còn lại (rỗng, chỉ DUPLICATE) -> chờ.
 */
export function connectionState(rows: InspectRow[] | undefined): ConnectionState {
  const list = rows ?? [];
  const rejected = list.find((r) => r.status === "REJECTED");
  if (list.some((r) => r.status === "ACCEPTED")) {
    return { kind: "connected", lastFailure: list[0]?.status === "REJECTED" ? list[0].diagnosis : null };
  }
  if (rejected) return { kind: "failing", diagnosis: rejected.diagnosis };
  return { kind: "waiting" };
}

/** Tách chẩn đoán thành lý do + tên header/trường để dựng câu i18n. Không có lý do -> "unknown". */
export function diagnosisParts(d: InspectDiagnosis): { reason: string; name: string | null; candidates: string[] } {
  return {
    reason: d.reason ?? "unknown",
    name: d.expectedHeader ?? d.expectedField ?? d.field ?? (d.expectedQueryParam ? `?${d.expectedQueryParam}` : null),
    candidates: d.candidateHeaders ?? [],
  };
}

/**
 * Mẫu xác thực mà form tay đưa ra. PK2 (ADR-203): `hmac` có tham số; bí danh cũ `hmac-sha256` chỉ còn cho source đã tạo
 * (server vẫn nhận), form không tạo mới bằng nó.
 */
export const GENERIC_SCHEMES = ["hmac", "static-token", "standard-webhooks"] as const;
export type GenericScheme = (typeof GENERIC_SCHEMES)[number];
/** `from-prefix` = chữ ký dạng `<algo>=<sig>` (Bitbucket, Jira, WebSub) -> `prefix: "<algo>="`, không gửi `algo`. */
export const HMAC_ALGO_CHOICES = ["sha256", "sha512", "sha1", "from-prefix"] as const;
export const KEY_ENCODING_CHOICES = ["utf8", "hex", "base64"] as const;
export const TOKEN_LOCATION_CHOICES = ["header", "basic", "query"] as const;
/** Giống `ALGO_IN_PREFIX` của @hub/providers (test so). */
export const ALGO_IN_PREFIX = "<algo>=";

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
}

/** Ô "tiêu đề chứa chữ ký / token" có dùng không (standard-webhooks đọc bộ cố định; basic dùng Authorization; query không có). */
export const needsHeader = (v: Pick<GenericFormValues, "scheme" | "location">): boolean =>
  v.scheme === "hmac" || (v.scheme === "static-token" && v.location === "header");
/** Ô tiền tố tĩnh có dùng không. */
export const needsPrefix = (v: Pick<GenericFormValues, "scheme" | "location" | "algo">): boolean =>
  needsHeader(v) && !(v.scheme === "hmac" && v.algo === "from-prefix");

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
  if (needsHeader(v)) config.header = v.header.trim().toLowerCase();
  if (v.scheme === "hmac") {
    // PK2: tham số HMAC. "Đọc từ tiền tố" -> prefix "<algo>=", không có algo.
    config.encoding = v.encoding;
    config.keyEncoding = v.keyEncoding;
    if (v.algo === "from-prefix") config.prefix = ALGO_IN_PREFIX;
    else config.algo = v.algo;
  }
  if (v.scheme === "static-token" && v.location !== "header") {
    config.location = v.location;
    if (v.location === "query") config.param = v.param.trim();
  }
  // Tiền tố KHÔNG trim (vd "Bearer " có dấu cách thật); rỗng = không có.
  if (needsPrefix(v) && v.prefix !== "") config.prefix = v.prefix;
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
  | "secret-basic";

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
  if (v.scheme === "hmac" && v.keyEncoding === "hex" && !HEX_KEY_RE.test(secret)) out.push({ path: "secret", issue: "secret-hex" });
  if (v.scheme === "hmac" && v.keyEncoding === "base64" && (!B64_KEY_RE.test(secret) || secret.length === 0)) out.push({ path: "secret", issue: "secret-base64" });
  if (v.scheme === "static-token" && v.location === "basic" && !secret.includes(":")) out.push({ path: "secret", issue: "secret-basic" });
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
