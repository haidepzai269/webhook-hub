/**
 * DX1 (SPEC-dev-experience §2, ADR-055): danh mục lỗi của API service `/v1/p/:project/*` và console `/api/v1/*`.
 * `error` là mã máy đọc, ỔN ĐỊNH (đổi = breaking). `message`/`fix` tiếng Anh theo thông lệ API; giải thích tiếng
 * Việt ở docs/ERRORS.md (test UX4: mỗi mã có `## <mã>`).
 *
 * Luật an toàn (UX2/UX3/UX5): `fix` là hàm THUẦN, chỉ đọc các tham số liệt kê ở `params`; tham số không bao giờ là
 * key, secret, giá trị header chữ ký hay body của request. Thêm mã mới = thêm mục ở đây + `## <mã>` ở ERRORS.md
 * (test quét mã lỗi trong apps/hub-api/src sẽ đỏ nếu quên).
 */
export interface ErrorDef {
  status: number;
  message: string;
  /** Tham số được phép ra body (lấy từ body gốc của exception). Mọi trường khác bị bỏ. */
  params?: readonly string[];
  fix: (p: Record<string, unknown>) => string;
}

const s = (v: unknown, fallback: string) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : fallback);

export const ERROR_CATALOG = {
  // ---- xác thực / quyền ----
  invalid_api_key: {
    status: 401,
    message: 'The API key is missing, malformed, revoked or unknown.',
    fix: () => 'Check HUB_URL / the Authorization: Bearer hk_… header. The key may have been revoked — create a new key in the console (Project → Keys).',
  },
  unauthenticated: {
    status: 401,
    message: 'You are not signed in.',
    fix: () => 'Sign in to the console again.',
  },
  session_expired: {
    status: 401,
    message: 'Your session has expired.',
    fix: () => 'Sign in to the console again.',
  },
  csrf_failed: {
    status: 403,
    message: 'The CSRF token is missing or invalid.',
    fix: () => 'Reload the console page and retry. API clients must send the x-csrf-token header matching the csrf cookie.',
  },
  missing_scope: {
    status: 403,
    message: 'This credential lacks the scope required for this action.',
    params: ['required'],
    fix: (p) => `Create a key with scope "${s(p.required, '<scope>')}" in the console (Project → Keys), or ask the project owner.`,
  },
  forbidden: {
    status: 403,
    message: 'You are not allowed to perform this action.',
    fix: () => 'Ask a project owner for the required role.',
  },
  owner_required: {
    status: 403,
    message: 'Only a project owner can do this.',
    fix: () => 'Ask a project owner to perform this action or to grant you the owner role.',
  },
  operator_required: {
    status: 403,
    message: 'Only a hub operator can do this.',
    fix: () => 'Alerts and alert settings are for hub operators. Sign in with an operator account, or ask the hub admin.',
  },
  email_not_verified: {
    status: 403,
    message: 'Verify your email first.',
    fix: () => 'Open the verification link sent to your email. Until then use test mode (test projects, hk_test_ keys).',
  },
  invite_email_mismatch: {
    status: 403,
    message: 'This invitation was sent to a different email address.',
    fix: () => 'Sign in with the invited account, or ask the owner to invite this email.',
  },
  project_limit: {
    status: 403,
    message: 'You have reached the maximum number of projects.',
    params: ['limit'],
    fix: (p) => `You can own at most ${Number.isInteger(p.limit) ? p.limit : 'the allowed number of'} projects. Delete an unused project or verify your email to raise the limit.`,
  },
  // ---- không tìm thấy (MỘT câu cho "không tồn tại" lẫn "của project khác" — chống dò) ----
  not_found: {
    status: 404,
    message: 'The resource was not found.',
    fix: () => 'Check the project slug in your connection string and the resource id. Resources of other projects are reported as not found.',
  },
  // ---- dữ liệu vào ----
  bad_request: {
    status: 400,
    message: 'The request is invalid.',
    params: ['field'],
    fix: (p) => (p.field ? `Fix "${s(p.field, 'the field')}" (rule in "detail") and retry.` : 'Fix the request (see "detail") and retry.'),
  },
  project_required: {
    status: 400,
    message: 'This console route needs a project.',
    fix: () => 'Add ?projectId=<uuid> (the console does this for the selected project).',
  },
  token_invalid: {
    status: 400,
    message: 'The link or token is invalid or has expired.',
    fix: () => 'Request a new link.',
  },
  invalid_cursor: {
    status: 400,
    message: 'The polling cursor is invalid.',
    params: ['field'],
    fix: () => 'Use nextCursor (or event.cursor) from the previous response, or after=latest to start from now. Do not use the dashboard "seq".',
  },
  invalid_event_pattern: {
    status: 400,
    message: 'One or more event type patterns are invalid.',
    fix: () => 'Use lower-case segments separated by "." with a wildcard only at the end, e.g. payment.*, repo.push or *.',
  },
  validation_failed: {
    status: 422,
    message: 'A field failed validation.',
    params: ['field', 'invalid'],
    fix: (p) => `Fix field "${s(p.field, 'the field')}" (rule in "detail") and retry.`,
  },
  schema_mismatch: {
    status: 422,
    message: 'The data does not match the canonical schema of this event type.',
    params: ['type', 'field'],
    fix: (p) =>
      `"${s(p.type, 'payment.* / repo.*')}" is a canonical type: field "${s(p.field, '?')}" has the wrong shape. See docs/EVENT-CATALOG.md, or publish under your own namespace (e.g. order.created).`,
  },
  scope_not_grantable: {
    status: 422,
    message: 'You cannot grant this scope.',
    params: ['field'],
    fix: () => 'Choose scopes your role can grant (see "detail"), or ask a project owner to create the key.',
  },
  outside_read_types: {
    status: 422,
    message: 'The subscription asks for event types outside this key\'s read types.',
    params: ['field', 'invalid'],
    fix: () => 'Subscribe only to types the key may read, or create a key with wider read types.',
  },
  unknown_source: {
    status: 422,
    message: 'One or more sources do not exist in this project.',
    params: ['ids', 'keys'],
    fix: () => 'Use source ids / sourceKeys of this project (GET /v1/p/:project/sources with scope manage:sources, or the console).',
  },
  no_publish_source: {
    status: 422,
    message: 'This key has no "api" source to publish into.',
    fix: () => 'Create a new key with scope "publish:events" — the hub creates its api source together with the key.',
  },
  missing_idempotency_key: {
    status: 422,
    message: 'No idempotency key could be derived for this event.',
    params: ['source'],
    fix: () => 'Send idempotencyKey (POST /events) or configure "idempotency" on the custom source.',
  },
  payload_too_large: {
    status: 413,
    message: 'The request body is too large.',
    params: ['limit'],
    fix: (p) => `Send at most ${s(p.limit, '1MB')} per request.`,
  },
  unsupported_media_type: {
    status: 415,
    message: 'Unsupported Content-Type.',
    fix: () => 'Send Content-Type: application/json.',
  },
  // ---- trạng thái / xung đột ----
  source_inactive: {
    status: 409,
    message: 'The source this key publishes into is disabled.',
    fix: () => "Re-enable the key's api source in the console (Sources), or create a new key with scope \"publish:events\".",
  },
  destination_archived: {
    status: 409,
    message: 'The destination (or subscription) of this delivery was removed from the flow (archived).',
    params: ['field'],
    fix: () => 'Archived items cannot receive deliveries. Create a new destination/subscription and let new events flow there; history stays readable.',
  },
  destination_inactive: {
    status: 409,
    message: 'The destination of this delivery is disconnected (isActive=false).',
    params: ['field'],
    fix: () => 'Reconnect the destination (PATCH /api/v1/destinations/:id {"isActive": true} or "Kết nối lại" on the flow map), then replay.',
  },
  subscription_inactive: {
    status: 409,
    message: 'The subscription of this delivery is turned off (isActive=false).',
    params: ['field'],
    fix: () => 'Turn the subscription back on (PATCH /api/v1/subscriptions/:id {"isActive": true}), then replay.',
  },
  conflict: {
    status: 409,
    message: 'The request conflicts with the current state of the resource.',
    params: ['field', 'code', 'subscriptionCount', 'deliveryCount'],
    fix: () => 'See "detail"; reload the resource and retry.',
  },
  // QT9 (SPEC-han-muc-dung-luong §10, Q11): trần số source chưa lưu trữ mỗi project.
  source_limit: {
    status: 409,
    message: 'This project has reached the maximum number of sources.',
    params: ['limit'],
    fix: (p) => `A project can have at most ${Number.isInteger(p.limit) ? p.limit : 'the allowed number of'} active sources. Archive ("Delete" on the flow map) a source you no longer use, or ask the hub operator.`,
  },
  slug_taken: {
    status: 409,
    message: 'A project with this slug already exists.',
    fix: () => 'Choose another slug.',
  },
  already_member: {
    status: 409,
    message: 'This email is already a member of the project.',
    fix: () => 'Change the member\'s role instead of inviting again.',
  },
  last_owner: {
    status: 409,
    message: 'A project must keep at least one owner.',
    fix: () => 'Make another member owner first.',
  },
  adoption_not_verified: {
    status: 409,
    message: 'The existing endpoint could not prove it holds the signing secret; ownership was not transferred.',
    params: ['verificationError'],
    fix: (p) => verificationFix(typeof p.verificationError === 'string' ? p.verificationError : null) ?? 'Make the endpoint answer the challenge, then retry.',
  },
  rate_limited: {
    status: 429,
    message: 'Too many requests.',
    params: ['retryAfter'],
    fix: (p) => (Number.isFinite(p.retryAfter) ? `Wait ${p.retryAfter} seconds and retry.` : 'Slow down and retry later (see "detail" for the limit).'),
  },
  // EG2 (SPEC-chong-qua-tai §4.2, ADR-177): hộp phạt của `/hooks/*` — IP gửi nhiều request vào sourceKey không tồn tại,
  // hoặc cặp (IP, sourceKey) ký sai liên tục, bị tạm chặn. `retryAfter` = số giây phạt còn lại (cũng nằm ở header Retry-After).
  ip_temporarily_blocked: {
    status: 429,
    message: 'This IP is temporarily blocked from sending webhooks (too many unknown-source or bad-signature requests).',
    params: ['retryAfter'],
    fix: (p) => `Check the webhook URL (sourceKey) and the signing secret configured at the provider, then retry${Number.isFinite(p.retryAfter) ? ` after ${p.retryAfter} seconds` : ' later'}.`,
  },
  // EG1 (ADR-176): KHÔNG do Node trả — body tĩnh của nginx (docker/nginx/nginx.conf.template) khi cầu chì IP chặn
  // /hooks/* hoặc /v1/p/*. Khai ở đây để mã ổn định + có mục trong ERRORS.md; test [EG:T10] so message với template.
  edge_rate_limited: {
    status: 429,
    message: 'Too many requests from this IP address.',
    params: ['retryAfter'],
    fix: () => 'Slow down and retry after the number of seconds in Retry-After. Providers retry on 429 by themselves.',
  },
  // ---- kết nối hai đầu (SPEC-ket-noi, ADR-138) ----
  use_endpoints_route: {
    status: 422,
    message: 'Webhook endpoints are created through the endpoints route (the hub generates the secret and runs the challenge).',
    fix: () => 'POST /api/v1/endpoints with {name, url, eventTypes, sourceIds?} — the response shows the whsec_ secret once. /destinations is for telegram/discord.',
  },
  endpoint_owned_by_service: {
    status: 409,
    message: 'This endpoint is managed by a service API key.',
    fix: () => 'Rotate the secret from the service itself (POST /v1/p/:project/endpoints/:id/verify with {signingSecret}) — the SDK ensure() does this.',
  },
  connector_unsupported: {
    status: 422,
    message: 'The hub cannot register its URL at this provider automatically.',
    params: ['provider'],
    fix: (p) => `Create the source with POST /api/v1/sources and paste its ingest URL into the ${s(p.provider, 'provider')} dashboard yourself.`,
  },
  public_url_required: {
    status: 422,
    message: 'HUB_PUBLIC_URL is not reachable from the internet, so the provider cannot call the hub.',
    fix: () => 'Use a named cloudflared tunnel or the deployed hub, and set HUB_PUBLIC_URL to its public https URL.',
  },
  overwrite_not_acknowledged: {
    status: 422,
    message: 'Connecting replaces the webhook URL currently set at the provider.',
    params: ['field'],
    fix: () => 'Send "acknowledgeOverwrite": true after confirming no backend still needs the old URL (each PayOS channel has a single webhook URL).',
  },
  credentials_required: {
    status: 422,
    message: 'The stored provider credentials were deleted.',
    fix: () => 'Reconnect with POST /api/v1/sources/:id/connection/retry and the credentials in the body.',
  },
  // ---- hạn mức dung lượng (SPEC-han-muc-dung-luong §4 + E1/E4, ADR-182/189) ----
  // QT:T20 (§5.1, ADR-184): event đã "Dọn" — dòng gầy giữ chống trùng, không còn nội dung để replay.
  event_trimmed: {
    status: 409,
    message: 'The content of this event was cleaned up to free storage; it can no longer be replayed.',
    fix: () => 'Trimmed events keep only their dedup key, type and timestamps. Replay is not possible; ask the sender to resend if you still need the data.',
  },
  // 507 Insufficient Storage: KHÔNG 2xx (BB-3 giữ, provider tự gửi lại). Trả TRƯỚC verify/rate limit — 0 HMAC, 0 Redis.
  project_storage_full: {
    status: 507,
    message: 'This project has reached its storage quota and is not accepting new events.',
    fix: () =>
      'Free space in the console (Storage: apply a cleanup suggestion, or trim / delete old events), or ask the hub operator to raise the quota. Sources marked "keep longer" are still accepted up to 110%. Already stored events keep being delivered; the provider will retry this request.',
  },
  // ---- máy chủ (KHÔNG lộ stack/message gốc) ----
  internal_error: {
    status: 500,
    message: 'Internal error.',
    fix: () => 'Retry later. If it persists, send the requestId to the hub admin.',
  },
  service_unavailable: {
    status: 503,
    message: 'The service is temporarily unavailable.',
    params: ['retryAfter'],
    fix: (p) => (Number.isFinite(p.retryAfter) ? `Retry in ${p.retryAfter}s (with backoff). If it persists, send the requestId to the hub admin.` : 'Retry with backoff. If it persists, send the requestId to the hub admin.'),
  },
} as const satisfies Record<string, ErrorDef>;

export type HubErrorCode = keyof typeof ERROR_CATALOG;

export function isHubErrorCode(code: unknown): code is HubErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code);
}

/** Mã suy ra từ HTTP status khi exception không mang mã (vd BadRequestException('…') của Nest). */
export function codeForStatus(status: number): HubErrorCode {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthenticated';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 413: return 'payload_too_large';
    case 415: return 'unsupported_media_type';
    case 422: return 'validation_failed';
    case 429: return 'rate_limited';
    case 503: return 'service_unavailable';
    default: return status >= 500 ? 'internal_error' : 'bad_request';
  }
}

/** `HUB_DOCS_URL` (mặc định `docs/ERRORS.md`) + `#<mã>`. */
export function docsUrlFor(code: string, base = process.env.HUB_DOCS_URL || 'docs/ERRORS.md'): string {
  return `${base}#${code}`;
}

/**
 * DX1 §2.3: gợi ý sửa cho `verificationError` của challenge endpoint (tạo endpoint, `/verify`, adopt). null = đã VERIFIED.
 * `ssrf_blocked` nêu CẢ HAI trường hợp: service đã deploy (đăng ký URL công khai) và dev local (`hub listen`).
 */
export function verificationFix(code: string | null | undefined): string | null {
  if (!code) return null;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) {
    return `Your endpoint answered HTTP ${http[1]}. It must answer 200 with JSON {"challenge": "<value received>"} — use hub.challengeResponse(body) from the SDK (after verifyWebhook).`;
  }
  switch (code) {
    case 'timeout':
      return 'Your endpoint must answer within 10s. Check the app is running and the URL is reachable from the hub.';
    case 'challenge_mismatch':
      return 'Answer with exactly {"challenge": "<value received>"} — use hub.challengeResponse(body) from the SDK.';
    case 'invalid_json':
      return 'The endpoint answered a non-JSON body. Answer 200 with JSON {"challenge": "<value received>"} (hub.challengeResponse(body)).';
    case 'ssrf_blocked':
      return (
        'The URL points to a private/internal address, which the hub blocks. ' +
        'Deployed service: register its PUBLIC URL instead (e.g. set SHOP_PUBLIC_URL to the https URL of the service). ' +
        'Local development: do not register localhost — run `npx hub listen --forward http://localhost:3000/webhooks` to receive events on your machine.'
      );
    case 'unreachable':
      return 'The hub could not connect (DNS error, connection refused or TLS failure). Check the host name, port and that the service is running and public.';
    case 'invalid_url':
      return 'The endpoint has no valid http(s) URL. Recreate it with a public https URL.';
    case 'no_signing_secret':
      return 'The endpoint has no signing secret. Call /verify with {"signingSecret": "whsec_…"} or recreate the endpoint.';
    default:
      return 'Check that the endpoint is reachable and answers the challenge (see docs/ERRORS.md).';
  }
}
