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
    name: d.expectedHeader ?? d.expectedField ?? d.field ?? null,
    candidates: d.candidateHeaders ?? [],
  };
}

export const GENERIC_SCHEMES = ["hmac-sha256", "static-token", "standard-webhooks"] as const;
export type GenericScheme = (typeof GENERIC_SCHEMES)[number];

export interface GenericFormValues {
  scheme: GenericScheme;
  header: string;
  encoding: "hex" | "base64";
  idKind: "header" | "field";
  idValue: string;
  eventType: string;
}

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
  const sw = v.scheme === "standard-webhooks";
  const config: Record<string, unknown> = { scheme: v.scheme };
  if (!sw) config.header = v.header.trim().toLowerCase();
  if (v.scheme === "hmac-sha256") config.encoding = v.encoding;
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
