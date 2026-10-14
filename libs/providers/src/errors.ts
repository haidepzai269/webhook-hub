/**
 * S8 (SPEC §4.8): lỗi CHUNG (không riêng provider nào) — adapter không lấy được khoá chống trùng từ request
 * theo cấu hình của source. Lõi ingest bắt lỗi này: lưu raw_event REJECTED, trả 422
 * `{error:"missing_idempotency_key"}`. KHÔNG fallback ulid (ulid ngẫu nhiên = gửi lại thành 2 sự kiện, BB-2).
 */
export class IdempotencyKeyMissingError extends Error {
  readonly code: 'missing_idempotency_key' | 'empty_body' = 'missing_idempotency_key';
  constructor(readonly where: string) {
    super(`Thiếu khoá chống trùng (${where})`);
    this.name = 'IdempotencyKeyMissingError';
  }
}

/**
 * PK10 (SPEC-provider-khac E31, ADR-230): khoá chống trùng theo băm body (`idempotency.bodyHash`, hoặc `path` thiếu giá trị)
 * mà body RỖNG — không có byte để băm có nghĩa (mọi request rỗng thành một khoá, nuốt nhau). Lõi xử lý như
 * `IdempotencyKeyMissingError` (REJECTED, signature_valid = true, 422) nhưng `error` là `empty_body` để dev biết vì sao.
 */
export class EmptyBodyIdempotencyError extends IdempotencyKeyMissingError {
  override readonly code = 'empty_body' as const;
  constructor() {
    super('bodyHash: body rỗng');
    this.name = 'EmptyBodyIdempotencyError';
  }
}

/**
 * S14 (§4.14.4): body thiếu trường đã khai trong `mapping` -> lỗi normalize VĨNH VIỄN (luật 4). Thông điệp chỉ
 * có TÊN trường (không giá trị) — `diagnose` của chế độ lắng nghe dùng lại đúng tên này.
 */
export class MappingFieldMissingError extends Error {
  constructor(readonly field: string) {
    super(`mapping_field_missing: ${field}`);
    this.name = 'MappingFieldMissingError';
  }
}
