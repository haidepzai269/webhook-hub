// PK1 (SPEC-provider-khac §3, ADR-202): logic thuần của tab "Lắng nghe" và form tay "Provider khác" (generic).
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
  if (idValue) config.idempotency = v.idKind === "header" ? { header: idValue.toLowerCase() } : { field: idValue };
  config.eventType = v.eventType.trim();
  return config;
}
