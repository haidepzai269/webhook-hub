import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';

/**
 * S8 (SPEC §4.8): cấu hình RIÊNG của source (`sources.verification_config`) mà lõi chuyển cho adapter, không đọc.
 * 4 adapter cố định bỏ qua; GenericAdapter dựa vào nó. Lõi KHÔNG `if (provider === 'generic')`.
 */
export interface AdapterContext {
  verificationConfig?: unknown;
  /**
   * PK3 (E2): "bây giờ" khi kiểm độ lệch timestamp (`standard-webhooks`, `signed-template`). Ingest thường KHÔNG truyền
   * (= `Date.now()`); verify bù của chế độ thu (PK6) truyền `received_at` của dòng thu (DB đặt, không giả được).
   */
  verifyAt?: Date;
}

/**
 * S9: raw_event ĐÃ LƯU (header đã che, body REJECTED là mẫu ≤4KB) — đầu vào của `diagnose`. `bodyRaw` vắng khi inspect
 * (review PK1 T-4: poll 2s không kéo `body_raw` từ DB) — `diagnose` không được cần bytes gốc.
 */
export interface StoredRawEvent {
  status: string;
  signatureValid: boolean;
  headers: unknown;
  body: unknown;
  bodyRaw?: Buffer | Uint8Array;
  receivedAt: Date;
}

/**
 * S9 (SPEC §4.8, §4.14.4): kết quả chẩn đoán cho "chế độ lắng nghe". CHỈ tên header/trường — tuyệt đối không giá trị
 * chữ ký, token, secret hay dữ liệu body.
 */
export interface Diagnosis {
  ok: boolean;
  reason?:
    | 'ok'
    | 'missing_header'
    | 'signature_mismatch'
    | 'token_mismatch'
    | 'timestamp_out_of_range'
    /** Review PK3 T-6: signed-template dạng kv — header chữ ký có mặt nhưng thiếu khoá timestamp (`expectedKvKey`). */
    | 'missing_kv_key'
    | 'missing_idempotency_key'
    | 'mapping_field_missing'
    | 'mapping_field_invalid'
    | 'config_invalid';
  expectedHeader?: string;
  expectedField?: string;
  candidateHeaders?: string[];
  field?: string;
  /** PK2: TÊN tham số query chứa token (static-token location query). Giá trị không bao giờ được lưu. */
  expectedQueryParam?: string;
  /** Review PK3 T-6: TÊN khoá thiếu trong header khoá=giá trị (vd `t` của `stripe-signature`). */
  expectedKvKey?: string;
}

/**
 * KN2 (SPEC-ket-noi §4.1, ADR-138): NĂNG LỰC TUỲ CHỌN "hub tự đăng ký URL ingest tại provider" (biến thể A).
 * Lõi chỉ hỏi `adapter.connector ? … : 422 connector_unsupported` — không bao giờ `switch (provider)`.
 * Mọi từ vựng của provider (tên trường, URL API, cách gọi) nằm trong connector của chính adapter đó.
 */
export interface ConnectorField {
  name: string;
  label: string;
  /** true -> UI dùng ô mật khẩu, response chỉ có 4 ký tự cuối. */
  secret: boolean;
  help: string;
}

export interface ConnectorSpec {
  /** UI dựng form từ đây. */
  fields: ConnectorField[];
  /** Trường credentials CŨNG là secret ký mà `adapter.verify` dùng (PayOS `checksumKey`) -> hub lưu SourceSecret TRƯỚC khi gọi provider. */
  sourceSecretField?: string;
  /** Có -> kết nối THAY cấu hình đang có ở provider; body bắt buộc `acknowledgeOverwrite: true` (422 nếu thiếu). */
  overwriteWarning?: string;
  /** Gợi ý quyền tối thiểu cho key (§4.3 điều 6). */
  keyHint: string;
  /** Không có `disconnect` -> câu hướng dẫn ngắt tay hiện ở UI. */
  manualDisconnect?: string;
  /** URL API thật (production luôn dùng cái này, không đọc env). */
  defaultBaseUrl: string;
  /** Tên biến môi trường trỏ tới fake provider — CHỈ đọc ngoài production (production có biến này -> app không khởi động). */
  fakeBaseUrlEnv: string;
}

export interface ConnectResult {
  /** id phía provider: PayOS số tài khoản đã che, Stripe `we_…`. Không nhạy cảm. */
  remoteRef: string;
  /** Dòng hiển thị, vd "CAFE ABC · ****1234". */
  display: string;
  /** Provider SINH secret ký (Stripe) -> hub lưu thành SourceSecret version mới. */
  sourceSecret?: string;
}

export interface ConnectorCallInput {
  credentials: Record<string, string>;
  baseUrl: string;
}

export interface ProviderConnector {
  spec: ConnectorSpec;
  /** `secretForSource`: secret ký mà `adapter.verify` sẽ dùng, nếu dev nhập (PayOS `checksumKey`). */
  connect(input: ConnectorCallInput & { ingestUrl: string; secretForSource?: string }): Promise<ConnectResult>;
  status?(input: ConnectorCallInput & { remoteRef: string; ingestUrl: string }): Promise<'ok' | 'drifted' | 'gone'>;
  disconnect?(input: ConnectorCallInput & { remoteRef: string }): Promise<void>;
}

/** Lỗi của provider khi kết nối — `code` ngắn (lưu `last_error`), `fix` theo khuôn ADR-136 (lưu `last_fix`). Không bao giờ chứa credentials. */
export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    readonly fix: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ConnectorError';
  }
}

export interface ProviderAdapter {
  readonly provider: ProviderType;

  /**
   * Xác thực request webhook.
   * Nhận MẢNG secret để hỗ trợ xoay secret (secret rotation).
   * Tính trên raw bytes (rawBody).
   */
  verify(req: RawWebhookRequest, secrets: string[], ctx?: AdapterContext): Promise<boolean>;

  /**
   * Khóa chống trùng (idempotency key), ổn định giữa các lần provider gửi lại (redelivery).
   * Không lấy được -> ném `IdempotencyKeyMissingError` (lõi trả 422, KHÔNG fallback ulid).
   */
  extractIdempotencyKey(req: RawWebhookRequest, ctx?: AdapterContext): string;

  /**
   * Chữ ký (hoặc bằng chứng xác thực) để lưu vào `raw_events.signature_header` (S3-1).
   * Mỗi adapter tự biết chữ ký của mình nằm ở đâu — lõi ingest không đoán header.
   * Nếu bằng chứng là một bí mật dùng chung (API key) thì PHẢI che, không trả key thật.
   * Không có -> null.
   */
  extractSignature(req: RawWebhookRequest, ctx?: AdapterContext): string | null;

  /**
   * S8: header (viết thường) mang BÍ MẬT theo cấu hình của source — lõi che chúng trước khi lưu raw_events,
   * ngoài danh sách cố định của redactHeaders. Không có -> không cài.
   */
  sensitiveHeaders?(ctx?: AdapterContext): string[];

  /** S9: chẩn đoán một raw_event đã lưu. Không cài -> lõi trả `{ok: signatureValid}`. */
  diagnose?(raw: StoredRawEvent, ctx?: AdapterContext): Diagnosis;

  /**
   * Chuyển đổi payload gốc thành mảng sự kiện chuẩn hóa (NormalizedEvent).
   */
  normalize(
    req: RawWebhookRequest,
    context: {
      tenantId: string;
      sourceId: string;
      correlationId: string;
      rawEventId: string;
      /** `raw_events.received_at` (ISO) — thời gian dự phòng ổn định khi renormalize (review SPEC-3 #4). */
      receivedAt?: string;
      /** S8: `sources.verification_config` (GenericAdapter). */
      verificationConfig?: unknown;
    },
  ): NormalizedEvent[];

  /**
   * Phản hồi HTTP status và body đúng định dạng provider mong đợi.
   */
  buildAck(result: IngestResult): { status: number; body: unknown };

  /** KN2: hub tự đăng ký URL ingest tại provider. Không có -> 422 `connector_unsupported` (dán URL tay). */
  readonly connector?: ProviderConnector;
}
