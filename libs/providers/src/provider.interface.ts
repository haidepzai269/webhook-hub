import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType, HttpMethod } from '@hub/common';

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
  /**
   * PK4 (E13): mở một giá trị đã mã hoá AES-GCM bằng master key (vd `handshake.verifyTokenEnc`). Lõi cài, KHÔNG đọc config —
   * adapter tự biết giá trị nào cần mở. Lỗi giải mã -> null (fail-closed). Không có (renormalize, inspect) -> adapter từ chối.
   */
  openSealed?: (enc: string) => string | null;
  /**
   * PK5 (E14, ADR-206): cờ của PROJECT mà adapter cần — nạp CÙNG câu với source (+0 lượt DB, như `storageLevel`). Lõi chỉ
   * chuyển qua, không đọc. Vắng (renormalize, inspect, đối chiếu secret) = mọi cờ tắt (fail-closed).
   */
  projectFlags?: { allowUnverified: boolean };
  /**
   * PK5 (E6/E18): URL công khai của CHÍNH request này (base ingest `HUB_INGEST_PUBLIC_URL`, thiếu thì `HUB_PUBLIC_URL` — ADR-211 — + `/hooks/<provider>/<sourceKey>` + query gốc), lõi
   * dựng từ env LÚC NHẬN — không bao giờ từ header `Host` (giả được). `null` khi hub không có URL công khai (localhost / IP
   * nội bộ). Hàm (lười): chỉ adapter cần mới gọi.
   */
  publicUrl?: () => string | null;
}

/**
 * PK5 (E5, E14, E17, ADR-206): kết quả `verify`. Adapter cũ trả `boolean` — lõi hiểu `true` là `{ok:true, verified:true}`.
 * - `{ ok: true, verified: false }`: NHẬN mà không xác thực (scheme `unverified`, cờ project bật) — lõi ghi
 *   `raw_events.verified=false`, `signature_valid` vẫn true ("không sai chữ ký").
 * - `{ ok: false, refusal }`: TỪ CHỐI KHÔNG phải vì chữ ký sai (cờ project tắt, body quá trần) — lõi KHÔNG lưu mẫu
 *   REJECTED, KHÔNG phạt EG2, không vào lưu lượng; chỉ trả status (401 -> `rejectStatus` của adapter; 413 nguyên văn).
 */
export interface VerifyRefusal {
  status: 401 | 413;
  /** Mã lỗi ổn định trong docs/ERRORS.md (vd `source_unverified_disabled`, `unverified_body_too_large`). */
  error: string;
  /** Câu sửa cho dev (ADR-136) — không bao giờ chứa giá trị header/secret/body. */
  fix: string;
}
export type VerifyResult = boolean | { ok: true; verified: boolean } | { ok: false; refusal?: VerifyRefusal };

/** PK5: chuẩn hoá kết quả `verify` (boolean cũ hoặc object mới). Mọi chỗ gọi `verify` đi qua đây — object luôn "truthy". */
export function verdictOf(r: VerifyResult): { ok: boolean; verified: boolean; refusal?: VerifyRefusal } {
  if (r === true) return { ok: true, verified: true };
  if (r === false || r === null || typeof r !== 'object') return { ok: false, verified: false };
  if (r.ok === true) return { ok: true, verified: r.verified !== false };
  return { ok: false, verified: false, ...(r.refusal ? { refusal: r.refusal } : {}) };
}

/**
 * PK4 (SPEC-provider-khac §6, E3/E8/E9, ADR-205): kết quả bắt tay của adapter. Lõi chỉ thực thi, không đọc config:
 * - `respond`: trả đúng phản hồi này (2xx), ghi MỘT dòng REJECTED `signature_valid=true` + `__hub_meta.reason='handshake'`;
 *   không event, không outbox, không SET NX, không EG3, 0 lệnh Redis.
 * - `reject`: như chữ ký sai (rejectStatus + `recordBadSignature`) — vd `query-echo` sai verify token.
 * - `invalid`: 400, không ghi DB, không phạt (giá trị echo ngoài tập ký tự E27, plainToken sai khuôn E3).
 */
export type HandshakeOutcome =
  | {
      kind: 'respond';
      status: 200 | 202 | 204;
      /** Chuỗi -> gửi nguyên văn (`contentType`); object -> JSON; null -> body rỗng. */
      body: string | Record<string, unknown> | null;
      contentType?: string;
      headers?: Record<string, string>;
      /** Ghi vào `__hub_meta.handshake` của dòng REJECTED (vd `{kind, subscribeUrl}`) — chỉ thứ console cần hiện. */
      meta: Record<string, unknown>;
    }
  | { kind: 'reject' }
  | { kind: 'invalid'; message: string };

/** PK4 (E9): 2h = trước verify (query/body/header-echo, manual-url); 3h = sau verify qua (hmac-echo, E3). */
export type HandshakePhase = 'before-verify' | 'after-verify';

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
    /** PK10 (E31): nguồn chống trùng theo băm body (`bodyHash` / `path` thiếu giá trị) nhận body rỗng. */
    | 'empty_body'
    /**
     * Review PK10 T-b: ACCEPTED nhưng `idempotency.path` trỏ object / mảng / boolean -> đã rơi về băm body. `ok: true` (nhận
     * được), `field` = TÊN path.
     */
    | 'idempotency_path_not_scalar'
    | 'mapping_field_missing'
    | 'mapping_field_invalid'
    | 'config_invalid'
    /**
     * PK5 khoá 2 (REVIEW-PK5 TB-1): ACCEPTED của nguồn `unverified` — đã NHẬN nhưng hub không kiểm chữ ký. `ok: true`
     * (kết nối thông) nhưng console KHÔNG được ghi "hợp lệ".
     */
    | 'unverified'
    /** PK4: dòng bắt tay (inspect gắn, không phải adapter). */
    | 'handshake';
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
   * PK5 (E5): được trả `VerifyResult` — gọi qua `verdictOf` (object luôn truthy, không dùng thẳng trong `if`).
   */
  verify(req: RawWebhookRequest, secrets: string[], ctx?: AdapterContext): Promise<VerifyResult>;

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

  /**
   * PK5 (E6, ADR-206): meta adapter muốn lõi lưu vào `headers.__hub_meta` của raw ACCEPTED, dựng LÚC NHẬN (vd URL công khai
   * khi `forwardUrl`). Worker chỉ đọc lại giá trị đã lưu — đổi env rồi renormalize không đổi URL. Không cài / null -> không lưu.
   */
  storedMeta?(req: RawWebhookRequest, ctx?: AdapterContext): Record<string, unknown> | null;

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
  buildAck(result: IngestResult, ctx?: AdapterContext): { status: number; body: unknown };

  /**
   * PK4 (§6.2, E27): method nào được vào ingest. Không cài -> chỉ POST. `HEAD` luôn 405 (lõi chặn trước khi hỏi).
   */
  acceptsMethod?(method: HttpMethod, ctx?: AdapterContext, req?: RawWebhookRequest): boolean;

  /**
   * PK4: request này có phải bắt tay của provider không (theo cấu hình source). null = không phải, đi tiếp như thường.
   * `secrets` đã giải mã — chỉ `after-verify` (hmac-echo) dùng, để ký bằng ĐÚNG secret đã verify.
   */
  handshake?(req: RawWebhookRequest, secrets: string[], ctx: AdapterContext | undefined, phase: HandshakePhase): HandshakeOutcome | null;

  /** KN2: hub tự đăng ký URL ingest tại provider. Không có -> 422 `connector_unsupported` (dán URL tay). */
  readonly connector?: ProviderConnector;
}
