/**
 * S8 (SPEC §4.8): lỗi CHUNG (không riêng provider nào) — adapter không lấy được khoá chống trùng từ request
 * theo cấu hình của source. Lõi ingest bắt lỗi này: lưu raw_event REJECTED, trả 422
 * `{error:"missing_idempotency_key"}`. KHÔNG fallback ulid (ulid ngẫu nhiên = gửi lại thành 2 sự kiện, BB-2).
 */
export class IdempotencyKeyMissingError extends Error {
  readonly code = 'missing_idempotency_key';
  constructor(readonly where: string) {
    super(`Thiếu khoá chống trùng (${where})`);
    this.name = 'IdempotencyKeyMissingError';
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
