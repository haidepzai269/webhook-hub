import { PAYMENT_TYPE_KEYS, isReservedType } from '@hub/common';
import { timingSafeCompare } from '@hub/crypto';

/**
 * Cấu hình GenericAdapter (`sources.verification_config`, SPEC §4.8 + §4.14.4). Kiểm lúc TẠO source — sai trả
 * 422 kèm tên trường. Không JSONPath, không dấu chấm: chỉ trường CẤP MỘT của body (John) — đọc được, bảo vệ được.
 *
 * PK2 (SPEC-provider-khac §4, ADR-203): `hmac` là THAM SỐ của cùng một thuật toán HMAC trên bytes body — `algo`,
 * `encoding`, `prefix` (tĩnh, hoặc `"<algo>="` = thuật toán đọc từ tiền tố), `keyEncoding`. Không biểu thức, không
 * vòng lặp. `hmac-sha256` là bí danh cũ, đọc ra `{algo:"sha256", keyEncoding:"utf8"}` qua `hmacParams` — khuôn lưu
 * của source cũ KHÔNG đổi, hành vi không đổi. `static-token` thêm `location`: header | basic | query.
 */
export type GenericScheme = 'hmac' | 'hmac-sha256' | 'static-token' | 'standard-webhooks' | 'signed-template';
export type MappingValue = string | { const: string | number };
export type HmacAlgo = 'sha1' | 'sha256' | 'sha512';
export type KeyEncoding = 'utf8' | 'hex' | 'base64';
export type TokenLocation = 'header' | 'basic' | 'query';
export type TimestampFormat = 'unix' | 'unix-ms' | 'iso8601';
/**
 * PK3 (SPEC-provider-khac §5, E16, ADR-204): chữ ký của `signed-template` nằm ở đâu.
 * - `{ headers, prefix? }`: 1–2 header, khớp MỘT là đủ (Box primary/secondary để xoay khoá).
 * - `{ header, kv }`: khoá=giá trị trong MỘT header (Stripe `t=…,v1=…`, Paddle `ts=…;h1=…`); nhiều `sig` = xoay khoá.
 */
export type SignatureLocation =
  | { headers: string[]; prefix?: string }
  | { header: string; kv: { sep: ';' | ','; sig: string; timestamp?: string } };

/**
 * PK4 (SPEC-provider-khac §6.1, E3/E13/E16/E20/E27, ADR-205): bắt tay khai báo được. `when` là MỘT cặp hằng (trường cấp
 * một của body HOẶC header) — không biểu thức.
 */
export type HandshakeWhen = { field: string; equals: string } | { header: string; equals: string };
export type HandshakeKind = 'query-echo' | 'body-echo' | 'header-echo' | 'hmac-echo' | 'manual-url' | 'head-ok';
export type HandshakeConfig =
  /** GET ?<param>=X -> 200 text/plain X (Meta, Dropbox, WebSub). `verifyTokenEnc`: token so khớp, AES-GCM (E13), KHÔNG phải SourceSecret. */
  | { kind: 'query-echo'; param: string; verifyTokenParam?: string; verifyTokenEnc?: string }
  /**
   * POST, `when` khớp -> 200 text/plain giá trị body.<echo.field> (Slack url_verification, Twitch). `respond: 'json'` -> 200
   * `application/json` `{<echo.field>: giá trị}` (monday) — cùng ECHO_RE, khoá JSON là tên trường đã khai (ADR-205 bổ sung).
   * `afterVerify: true` (review PK4 T-1): chỉ trả lời SAU verify qua — cho provider KÝ request bắt tay (Slack, Twitch).
   */
  | { kind: 'body-echo'; when: HandshakeWhen; echo: { field: string }; respond?: 'json'; afterVerify?: true }
  /** POST có header <header> -> 200, trả lại đúng header đó (Asana X-Hook-Secret). `adoptSecret` chỉ ở chế độ thu (PK6). */
  | { kind: 'header-echo'; header: string }
  /** POST, `when` khớp, CHỈ SAU verify qua (E3) -> 200 JSON {<tokenField>: t, <macField>: hex(HMAC-SHA256(secret, t))} (Zoom). */
  | { kind: 'hmac-echo'; when: HandshakeWhen; tokenField: string; tokenParent?: string; macField: string }
  /** POST, `when` khớp -> lưu mẫu, console hiện body.<urlField> cho dev tự bấm (SNS SubscribeURL). Hub KHÔNG gọi ra. */
  | { kind: 'manual-url'; when: HandshakeWhen; urlField: string; afterVerify?: true }
  /**
   * ADR-205 bổ sung (sửa E27): HEAD -> 200 rỗng (Intercom kiểm URL bằng HEAD). HEAD vẫn qua hộp phạt, checkIp, PK0, QT3,
   * checkPair; không ghi DB, không phạt, 0 Redis. Source không khai -> HEAD 405 như cũ.
   */
  | { kind: 'head-ok' };
/** PK4 §6.3: mã HTTP của ack. Từ chối KHÔNG bao giờ là 2xx (BB-3, EG2). */
export interface AckConfig {
  successStatus?: 200 | 202 | 204;
  rejectStatus?: 401 | 403 | 503;
}
export const HANDSHAKE_KINDS: readonly HandshakeKind[] = ['query-echo', 'body-echo', 'header-echo', 'hmac-echo', 'manual-url', 'head-ok'];
/** `body-echo.respond`: `text` (mặc định, không lưu) | `json`. */
export const ECHO_RESPONDS = ['text', 'json'] as const;
export const ACK_SUCCESS_STATUSES = [200, 202, 204] as const;
export const ACK_REJECT_STATUSES = [401, 403, 503] as const;
/** Giá trị hằng của `when.equals` (vd `url_verification`, `webhook_callback_verification`, `SubscriptionConfirmation`). */
export const WHEN_EQUALS_RE = /^[\x21-\x7E]{1,128}$/;
/** Token xác minh của `query-echo` (người dùng tự chọn khi đăng ký tại provider). Chỉ gửi lúc tạo source, server mã hoá. */
export const VERIFY_TOKEN_RE = /^[\x21-\x7E]{8,256}$/;

export interface GenericConfig {
  scheme: GenericScheme;
  header?: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
  /** PK2: chỉ scheme `hmac` (bí danh cũ luôn sha256). Vắng khi `prefix` là `"<algo>="`. PK3: `signed-template` sha256|sha512. */
  algo?: HmacAlgo;
  /**
   * Review PK2 T-3: tập thuật toán nhận được khi `prefix` là `"<algo>="`. Vắng = `DEFAULT_PREFIX_ALGOS` (sha256, sha512) —
   * sha1 phải khai rõ (WebSub). Kẻ gửi không hạ được xuống thuật toán ngoài tập.
   */
  algos?: HmacAlgo[];
  /** PK2: chỉ scheme `hmac` — secret giải mã thế nào trước khi làm khoá HMAC. */
  keyEncoding?: KeyEncoding;
  /** PK2: chỉ `static-token`; vắng = header (khuôn cũ). */
  location?: Exclude<TokenLocation, 'header'>;
  /** PK2: tên tham số query khi `location: "query"`. */
  param?: string;
  /** PK3 `signed-template`: chuỗi ký, chỉ 3 token `{timestamp}` `{body}` `{id}`; `{body}` đúng một lần. */
  template?: string;
  signature?: SignatureLocation;
  /** PK3: header chứa timestamp (vắng khi timestamp nằm trong `signature.kv`). */
  timestampHeader?: string;
  timestampFormat?: TimestampFormat;
  /** PK3: header chứa giá trị của `{id}` (bắt buộc khi template có `{id}`). */
  idHeader?: string;
  /** PK3: độ lệch tối đa giữa timestamp và "bây giờ" (giây, 5..900), bắt buộc khi có `{timestamp}`. */
  toleranceSec?: number;
  idempotency: { header: string } | { field: string };
  eventType: string;
  mapping?: Record<string, MappingValue>;
  timezone?: string;
  /** PK4: bắt tay lúc đăng ký URL. */
  handshake?: HandshakeConfig;
  /** PK4: mã HTTP của ack. */
  ack?: AckConfig;
}

export type ConfigCheck = { ok: true; config: GenericConfig } | { ok: false; field: string; message: string };

const SCHEMES: GenericScheme[] = ['hmac', 'hmac-sha256', 'static-token', 'standard-webhooks', 'signed-template'];
/**
 * Hai mẫu có `encoding` (tách hằng: gate sig-compare cấm `===`/`!==` trên dòng nhắc tới hmac). `LEGACY_SCHEME` là bí
 * danh cũ — giữ nguyên hành vi (sha256, khoá utf8, prefix tĩnh).
 */
const PARAM_SCHEME: GenericScheme = 'hmac';
const LEGACY_SCHEME: GenericScheme = 'hmac-sha256';
const TEMPLATE_SCHEME: GenericScheme = 'signed-template';
const SCHEMES_WITH_ENCODING: readonly GenericScheme[] = [PARAM_SCHEME, LEGACY_SCHEME];
const ENCODINGS = ['hex', 'base64'];
/** PK2: tập thuật toán. sha1 là ngoại lệ có chủ đích (provider quy định: Vercel, Intercom, Trello, WebSub), ADR-203. */
export const HMAC_ALGOS: readonly HmacAlgo[] = ['sha1', 'sha256', 'sha512'];
/** Review PK2 T-3: tập mặc định của `"<algo>="` khi config không khai `algos` (gồm config đã lưu trước bản này). */
export const DEFAULT_PREFIX_ALGOS: readonly HmacAlgo[] = ['sha256', 'sha512'];
export const KEY_ENCODINGS: readonly KeyEncoding[] = ['utf8', 'hex', 'base64'];
export const TOKEN_LOCATIONS: readonly TokenLocation[] = ['header', 'basic', 'query'];
/** PK2: giá trị `prefix` đặc biệt — chữ ký dạng `<algo>=<sig>` (Bitbucket, Jira, WebSub), thuật toán chỉ nhận trong `HMAC_ALGOS`. */
export const ALGO_IN_PREFIX = '<algo>=';
export const PREFIX_MAX = 32; // E15: giữ 32 như trước (thân spec ghi 16 là sai)
const HEADER_RE = /^[a-z0-9-]{1,64}$/;
export const FIELD_RE = /^[A-Za-z0-9_]{1,64}$/;
/** PK2: tên tham số query chứa token (vd `token`, `api_key`, `hub.verify`). */
export const PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const EVENT_TYPE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

/** Khoá ánh xạ được: phần lõi trừ `raw`/`counterparty`/`account` + khoá thời gian của kiểu (+ `reason` cho failed). */
const MAPPABLE_CORE = ['amount', 'currency', 'method', 'reference', 'memo', 'providerTxnId'];
const REQUIRED_CORE = ['amount', 'currency', 'method', 'providerTxnId'];

export function paymentTimeKey(eventType: string): string | null {
  return PAYMENT_TYPE_KEYS[eventType]?.[0] ?? null;
}

/** Tham số HMAC đã chuẩn hoá. `algo: null` = đọc từ tiền tố chữ ký (`"<algo>="`). */
export interface HmacParams {
  algo: HmacAlgo | null;
  encoding: 'hex' | 'base64';
  keyEncoding: KeyEncoding;
  /** Tiền tố tĩnh (không có khi đọc thuật toán từ tiền tố). */
  prefix?: string;
  /** Review PK2 T-3: chỉ khi `algo: null` — thuật toán tiền tố được nhận. */
  algos?: readonly HmacAlgo[];
}

/** Config là một mẫu HMAC (`hmac` hoặc bí danh cũ `hmac-sha256`). */
export const isHmacScheme = (c: Pick<GenericConfig, 'scheme'>): boolean => SCHEMES_WITH_ENCODING.includes(c.scheme);

/**
 * PK2: đọc tham số HMAC của config ĐÃ KIỂM. Bí danh cũ -> `{algo:"sha256", keyEncoding:"utf8"}`, prefix luôn tĩnh (kể cả
 * chuỗi `"<algo>="`: trước PK2 nó là chữ thường, không đổi nghĩa của source cũ).
 */
export function hmacParams(c: GenericConfig): HmacParams {
  const encoding = c.encoding ?? 'hex';
  if (c.scheme === LEGACY_SCHEME) return { algo: 'sha256', encoding, keyEncoding: 'utf8', ...(c.prefix !== undefined ? { prefix: c.prefix } : {}) };
  if (c.prefix === ALGO_IN_PREFIX) return { algo: null, encoding, keyEncoding: c.keyEncoding ?? 'utf8', algos: c.algos ?? DEFAULT_PREFIX_ALGOS };
  return { algo: c.algo ?? 'sha256', encoding, keyEncoding: c.keyEncoding ?? 'utf8', ...(c.prefix !== undefined ? { prefix: c.prefix } : {}) };
}

const HEX_KEY_RE = /^(?:[0-9a-fA-F]{2})+$/;
const B64_KEY_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/;

/**
 * PK2: khoá HMAC từ secret theo `keyEncoding`. Sai khuôn (hex lẻ / ký tự lạ, base64 hỏng) -> null: KHÔNG giải mã
 * "lỏng" (Buffer.from bỏ qua ký tự lạ — hai secret khác nhau thành cùng một khoá). Rỗng -> null.
 * Review PK2 T-4: base64 còn phải KHỨ HỒI (mã hoá lại ra đúng chuỗi, bỏ qua `=`): `AB==` và `AA==` cùng ra byte 0x00 —
 * bit thừa khác 0 bị từ chối, nên mỗi khoá chỉ có một cách viết.
 */
export function decodeHmacKey(secret: string, keyEncoding: KeyEncoding): Buffer | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  if (keyEncoding === 'utf8') return Buffer.from(secret, 'utf8');
  if (keyEncoding === 'hex') return HEX_KEY_RE.test(secret) ? Buffer.from(secret, 'hex') : null;
  if (!B64_KEY_RE.test(secret)) return null;
  const key = Buffer.from(secret, 'base64');
  if (!timingSafeCompare(key.toString('base64').replace(/=+$/, ''), secret.replace(/=+$/, ''))) return null;
  return key.length > 0 ? key : null;
}

/**
 * PK2: secret có dùng được với config không (kiểm lúc tạo source -> 422 `secret` thay vì 401 mãi về sau).
 * null = được; chuỗi = lý do.
 */
export function secretProblem(c: GenericConfig, secret: string): string | null {
  if (isHmacScheme(c) && decodeHmacKey(secret, hmacParams(c).keyEncoding) === null) {
    return `secret phải là chuỗi ${hmacParams(c).keyEncoding} hợp lệ (keyEncoding)`;
  }
  if (c.scheme === 'static-token' && c.location === 'basic' && !secret.includes(':')) {
    return 'basic: secret là "user:pass" (có dấu hai chấm)';
  }
  // Review PK2 T-5: query giải mã `+` thành dấu cách, `%xx` thành byte — token chứa ký tự cần mã hoá sẽ 401 mãi.
  if (c.scheme === 'static-token' && c.location === 'query' && !QUERY_TOKEN_RE.test(secret)) {
    return 'query: token chỉ gồm A-Z a-z 0-9 . _ ~ - (không cần mã hoá URL); có + / = & # % thì dùng tiêu đề hoặc Basic';
  }
  if (isTemplateScheme(c) && !decodeHmacKey(secret, c.keyEncoding ?? 'utf8')) {
    return `secret phải là chuỗi ${c.keyEncoding ?? 'utf8'} hợp lệ (keyEncoding)`;
  }
  return null;
}

/** Review PK2 T-5: ký tự không cần mã hoá URL (RFC 3986 unreserved). */
export const QUERY_TOKEN_RE = /^[A-Za-z0-9._~-]+$/;

const bad = (field: string, message: string): ConfigCheck => ({ ok: false, field, message });
const isAlgo = (x: unknown): boolean => (HMAC_ALGOS as readonly unknown[]).includes(x);
/** T-3: mảng thuật toán khác rỗng, không trùng, mỗi phần tử trong tập. */
const isAlgoList = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every(isAlgo) && new Set(v).size === v.length;
const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateGenericConfig(input: unknown): ConfigCheck {
  if (!isObj(input)) return bad('verificationConfig', 'provider generic bắt buộc có verificationConfig (object)');
  const c = input;
  if (!SCHEMES.includes(c.scheme)) return bad('scheme', `scheme là một trong ${SCHEMES.join(', ')}`);
  const scheme = c.scheme as GenericScheme;
  if (scheme === TEMPLATE_SCHEME) return validateSignedTemplate(c);
  const sw = scheme === 'standard-webhooks';
  const withEncoding = SCHEMES_WITH_ENCODING.includes(scheme);
  const isParam = scheme === PARAM_SCHEME;
  const isToken = scheme === 'static-token';

  // PK2: location chỉ cho static-token; vắng = header (khuôn cũ).
  if (c.location !== undefined && (!isToken || !TOKEN_LOCATIONS.includes(c.location))) {
    return bad('location', 'location chỉ cho static-token: header | basic | query');
  }
  const location: TokenLocation = isToken ? (c.location ?? 'header') : 'header';
  const headerless = sw || location !== 'header';
  if (location === 'query') {
    if (typeof c.param !== 'string' || !PARAM_RE.test(c.param)) return bad('param', 'param (tên tham số query) bắt buộc, ^[A-Za-z0-9_.-]{1,64}$');
  } else if (c.param !== undefined) {
    return bad('param', 'param chỉ dùng với static-token location "query"');
  }

  if (headerless) {
    if (c.header !== undefined) {
      return bad('header', sw ? 'standard-webhooks không có header (dùng webhook-id/timestamp/signature)' : `location "${location}" không có header`);
    }
    if (c.encoding !== undefined) return bad('encoding', sw ? 'standard-webhooks không có encoding' : 'encoding chỉ cho hmac');
  } else if (typeof c.header !== 'string' || !HEADER_RE.test(c.header)) {
    return bad('header', 'header bắt buộc, viết thường, ^[a-z0-9-]{1,64}$ (vd x-signature)');
  }
  if (c.encoding !== undefined && (!withEncoding || !ENCODINGS.includes(c.encoding))) {
    return bad('encoding', 'encoding chỉ cho hmac / hmac-sha256: hex | base64');
  }
  if (c.prefix !== undefined && (headerless || typeof c.prefix !== 'string' || c.prefix.length > PREFIX_MAX)) {
    return bad('prefix', 'prefix là chuỗi ≤ 32 ký tự (vd "sha256=", "Bearer ", hoặc "<algo>=" với hmac), không dùng với standard-webhooks / basic / query');
  }
  // PK2: algo/keyEncoding chỉ cho `hmac`; bí danh cũ giữ đúng sha256 + khoá utf8 (đổi thì dùng scheme hmac).
  if (c.algo !== undefined) {
    if (!isParam) return bad('algo', 'algo chỉ cho scheme hmac (hmac-sha256 luôn là sha256)');
    if (c.prefix === ALGO_IN_PREFIX) return bad('algo', 'prefix "<algo>=" đọc thuật toán từ chữ ký — bỏ trường algo');
    if (!HMAC_ALGOS.includes(c.algo)) return bad('algo', `algo là một trong ${HMAC_ALGOS.join(', ')}`);
  }
  // Review PK2 T-3: tập thuật toán của "<algo>=" (vắng = sha256 + sha512; sha1 phải khai rõ).
  if (c.algos !== undefined) {
    if (!isParam || c.prefix !== ALGO_IN_PREFIX) return bad('algos', 'algos chỉ dùng khi prefix là "<algo>=" (thuật toán đọc từ chữ ký)');
    if (!isAlgoList(c.algos)) return bad('algos', `algos là mảng không trùng, khác rỗng, gồm ${HMAC_ALGOS.join(', ')}`);
  }
  if (c.keyEncoding !== undefined && (!isParam || !KEY_ENCODINGS.includes(c.keyEncoding))) {
    return bad('keyEncoding', 'keyEncoding chỉ cho scheme hmac: utf8 | hex | base64');
  }

  const tail = parseTail(c, sw);
  if ('bad' in tail) return tail.bad;
  const { idempotency, eventType, mapping } = tail;

  const config: GenericConfig = { scheme, idempotency, eventType };
  if (!headerless) config.header = c.header;
  if (withEncoding) config.encoding = c.encoding ?? 'hex';
  if (isParam) {
    if (c.prefix !== ALGO_IN_PREFIX) config.algo = c.algo ?? 'sha256';
    config.keyEncoding = c.keyEncoding ?? 'utf8';
    if (c.algos !== undefined) config.algos = [...c.algos];
  }
  if (location !== 'header') config.location = location;
  if (location === 'query') config.param = c.param;
  if (c.prefix !== undefined) config.prefix = c.prefix;
  if (mapping) config.mapping = mapping;
  if (c.timezone !== undefined) config.timezone = c.timezone;
  if (tail.handshake) config.handshake = tail.handshake;
  if (tail.ack) config.ack = tail.ack;
  return handshakeConflict(config) ?? { ok: true, config };
}

type Tail =
  | {
      ok: true;
      idempotency: GenericConfig['idempotency'];
      eventType: string;
      mapping?: GenericConfig['mapping'];
      handshake?: HandshakeConfig;
      ack?: AckConfig;
    }
  | { ok: false; bad: ConfigCheck };

/** Phần chung mọi scheme: khoá chống trùng, kiểu sự kiện, múi giờ, ánh xạ (tách ra để `signed-template` dùng lại). */
function parseTail(c: Record<string, any>, sw: boolean): Tail {
  const fail = (field: string, message: string): Tail => ({ ok: false, bad: bad(field, message) });
  let idempotency: GenericConfig['idempotency'];
  if (c.idempotency === undefined && sw) {
    idempotency = { header: 'webhook-id' };
  } else {
    if (!isObj(c.idempotency)) return fail('idempotency', 'idempotency là {header} HOẶC {field}');
    const keys = Object.keys(c.idempotency);
    if (keys.length !== 1 || !['header', 'field'].includes(keys[0])) return fail('idempotency', 'idempotency có ĐÚNG MỘT trong header | field');
    if (keys[0] === 'header') {
      if (typeof c.idempotency.header !== 'string' || !HEADER_RE.test(c.idempotency.header)) {
        return fail('idempotency.header', 'header viết thường ^[a-z0-9-]{1,64}$');
      }
      idempotency = { header: c.idempotency.header };
    } else {
      if (typeof c.idempotency.field !== 'string' || !FIELD_RE.test(c.idempotency.field)) {
        return fail('idempotency.field', 'field là trường CẤP MỘT của body ^[A-Za-z0-9_]{1,64}$ (không JSONPath, không dấu chấm)');
      }
      idempotency = { field: c.idempotency.field };
    }
  }

  if (typeof c.eventType !== 'string' || c.eventType.length > 128 || !EVENT_TYPE_RE.test(c.eventType)) {
    return fail('eventType', 'eventType khớp ^[a-z0-9_]+(\\.[a-z0-9_]+)+$ (vd bank.transaction.received)');
  }
  const eventType: string = c.eventType;
  const timeKey = paymentTimeKey(eventType);

  if (c.timezone !== undefined && (typeof c.timezone !== 'string' || !OFFSET_RE.test(c.timezone))) {
    return fail('timezone', 'timezone dạng ±hh:mm (vd +07:00)');
  }

  let mapping: GenericConfig['mapping'];
  if (c.mapping === undefined) {
    // Luật 4 §4.14.1: kiểu dành riêng (payment.*, repo.*) mà không ánh xạ thì data không thể đúng khuôn.
    if (isReservedType(eventType)) return fail('mapping', `${eventType} là kiểu chuẩn: bắt buộc có mapping`);
  } else {
    if (!timeKey) return fail('mapping', 'mapping chỉ dùng cho payment.received | payment.sent | payment.failed | payment.refunded');
    if (!isObj(c.mapping)) return fail('mapping', 'mapping là object');
    const allowed = [...MAPPABLE_CORE, timeKey, ...(eventType === 'payment.failed' ? ['reason'] : [])];
    for (const [k, v] of Object.entries(c.mapping)) {
      if (!allowed.includes(k)) return fail(`mapping.${k}`, `khoá không ánh xạ được; cho phép: ${allowed.join(', ')}`);
      const okField = typeof v === 'string' && FIELD_RE.test(v);
      const okConst = isObj(v) && Object.keys(v).length === 1 && (typeof v.const === 'string' || typeof v.const === 'number');
      if (!okField && !okConst) return fail(`mapping.${k}`, 'giá trị là tên trường CẤP MỘT (^[A-Za-z0-9_]{1,64}$) hoặc {"const": chuỗi|số}');
    }
    for (const k of [...REQUIRED_CORE, timeKey]) {
      if (!(k in c.mapping)) return fail(`mapping.${k}`, `mapping thiếu trường bắt buộc ${k}`);
    }
    mapping = c.mapping as Record<string, MappingValue>;
  }

  const hs = parseHandshake(c.handshake);
  if ('bad' in hs) return { ok: false, bad: hs.bad };
  const ack = parseAck(c.ack);
  if ('bad' in ack) return { ok: false, bad: ack.bad };
  return {
    ok: true,
    idempotency,
    eventType,
    ...(mapping ? { mapping } : {}),
    ...(hs.value ? { handshake: hs.value } : {}),
    ...(ack.value ? { ack: ack.value } : {}),
  };
}

// ───────────────────────── PK4: handshake + ack (SPEC-provider-khac §6, ADR-205) ─────────────────────────

type Parsed<T> = { value?: T } | { bad: ConfigCheck };

function parseWhen(w: unknown, at: string): Parsed<HandshakeWhen> {
  // E16: `{field, equals}` HOẶC `{header, equals}` — một cặp hằng, không biểu thức.
  if (!isObj(w) || Object.keys(w).length !== 2 || !('equals' in w) || ('field' in w) === ('header' in w)) {
    return { bad: bad(at, 'when là {field, equals} HOẶC {header, equals}') };
  }
  if (typeof w.equals !== 'string' || !WHEN_EQUALS_RE.test(w.equals)) return { bad: bad(`${at}.equals`, 'equals là chuỗi ASCII in được, 1–128 ký tự') };
  if ('field' in w) {
    if (typeof w.field !== 'string' || !FIELD_RE.test(w.field)) return { bad: bad(`${at}.field`, 'field là trường CẤP MỘT của body ^[A-Za-z0-9_]{1,64}$') };
    return { value: { field: w.field, equals: w.equals } };
  }
  if (typeof w.header !== 'string' || !HEADER_RE.test(w.header)) return { bad: bad(`${at}.header`, 'header viết thường ^[a-z0-9-]{1,64}$') };
  return { value: { header: w.header, equals: w.equals } };
}

/**
 * PK4: kiểm `handshake`. Khoá lạ -> 422 (không im lặng bỏ: cấu hình bắt tay sai = provider không lưu được URL).
 * `verifyToken` (rõ) KHÔNG bao giờ nằm trong config đã lưu — `parseSourceInput` đổi nó thành `verifyTokenEnc` (E13).
 */
function parseHandshake(h: unknown): Parsed<HandshakeConfig> {
  if (h === undefined) return {};
  const fail = (field: string, message: string): Parsed<HandshakeConfig> => ({ bad: bad(`handshake.${field}`, message) });
  if (!isObj(h)) return { bad: bad('handshake', 'handshake là object {kind, …}') };
  if (!HANDSHAKE_KINDS.includes(h.kind)) return fail('kind', `kind là một trong ${HANDSHAKE_KINDS.join(', ')}`);
  const only = (allowed: string[]) => Object.keys(h).find((k) => k !== 'kind' && !allowed.includes(k));
  const field = (k: string, v: unknown): Parsed<HandshakeConfig> | null =>
    typeof v === 'string' && FIELD_RE.test(v) ? null : fail(k, `${k} là trường CẤP MỘT ^[A-Za-z0-9_]{1,64}$`);
  switch (h.kind as HandshakeKind) {
    case 'query-echo': {
      const extra = only(['param', 'verifyTokenParam', 'verifyTokenEnc']);
      if (extra) {
        return fail(extra, extra === 'verifyToken' ? 'verifyToken chỉ gửi lúc tạo source (server mã hoá thành verifyTokenEnc)' : `query-echo không có ${extra}`);
      }
      if (typeof h.param !== 'string' || !PARAM_RE.test(h.param)) return fail('param', 'param (tên tham số query mang challenge) ^[A-Za-z0-9_.-]{1,64}$');
      if (
        h.verifyTokenParam !== undefined &&
        (typeof h.verifyTokenParam !== 'string' || !PARAM_RE.test(h.verifyTokenParam) || h.verifyTokenParam === h.param)
      ) {
        return fail('verifyTokenParam', 'verifyTokenParam ^[A-Za-z0-9_.-]{1,64}$, khác param');
      }
      if (
        h.verifyTokenEnc !== undefined &&
        (typeof h.verifyTokenEnc !== 'string' || h.verifyTokenEnc.length === 0 || h.verifyTokenEnc.length > 2048 || h.verifyTokenParam === undefined)
      ) {
        return fail('verifyTokenEnc', 'verifyTokenEnc chỉ đi kèm verifyTokenParam (server ghi)');
      }
      return {
        value: {
          kind: 'query-echo',
          param: h.param,
          ...(h.verifyTokenParam !== undefined ? { verifyTokenParam: h.verifyTokenParam } : {}),
          ...(h.verifyTokenEnc !== undefined ? { verifyTokenEnc: h.verifyTokenEnc } : {}),
        },
      };
    }
    case 'body-echo': {
      const extra = only(['when', 'echo', 'respond', 'afterVerify']);
      if (extra) return fail(extra, `body-echo không có ${extra}`);
      const w = parseWhen(h.when, 'handshake.when');
      if ('bad' in w) return w;
      if (!isObj(h.echo) || Object.keys(h.echo).length !== 1) return fail('echo', 'echo là {field}');
      const e = field('echo.field', h.echo.field);
      if (e) return e;
      if (h.respond !== undefined && !(ECHO_RESPONDS as readonly unknown[]).includes(h.respond)) return fail('respond', 'respond là "text" (mặc định) | "json"');
      const av = afterVerifyOf(h.afterVerify);
      if (av === null) return fail('afterVerify', AFTER_VERIFY_MESSAGE);
      return {
        value: {
          kind: 'body-echo',
          when: w.value!,
          echo: { field: h.echo.field },
          ...(h.respond === 'json' ? { respond: 'json' as const } : {}),
          ...(av ? { afterVerify: true as const } : {}),
        },
      };
    }
    case 'head-ok': {
      const extra = only([]);
      if (extra) return fail(extra, `head-ok không có ${extra}`);
      return { value: { kind: 'head-ok' } };
    }
    case 'header-echo': {
      // E20 + PK4: adoptSecret chỉ có nghĩa ở chế độ thu (PK6 — secret nhận được ở trạng thái chờ, dev xác nhận). Source PK4
      // luôn có secret -> nhận secret từ request là cho kẻ biết sourceKey cấy khoá -> 422.
      if (h.adoptSecret !== undefined) {
        return fail('adoptSecret', 'adoptSecret chỉ dùng ở chế độ thu (source chưa có secret, PK6); source đã có secret không nhận secret từ request');
      }
      const extra = only(['header']);
      if (extra) return fail(extra, `header-echo không có ${extra}`);
      if (typeof h.header !== 'string' || !HEADER_RE.test(h.header)) return fail('header', 'header viết thường ^[a-z0-9-]{1,64}$ (vd x-hook-secret)');
      return { value: { kind: 'header-echo', header: h.header } };
    }
    case 'hmac-echo': {
      const extra = only(['when', 'tokenField', 'tokenParent', 'macField']);
      if (extra) return fail(extra, `hmac-echo không có ${extra}`);
      const w = parseWhen(h.when, 'handshake.when');
      if ('bad' in w) return w;
      const e =
        field('tokenField', h.tokenField) ?? (h.tokenParent !== undefined ? field('tokenParent', h.tokenParent) : null) ?? field('macField', h.macField);
      if (e) return e;
      if (h.macField === h.tokenField) return fail('macField', 'macField khác tokenField');
      return {
        value: {
          kind: 'hmac-echo',
          when: w.value!,
          tokenField: h.tokenField,
          ...(h.tokenParent !== undefined ? { tokenParent: h.tokenParent } : {}),
          macField: h.macField,
        },
      };
    }
    case 'manual-url': {
      const extra = only(['when', 'urlField', 'afterVerify']);
      if (extra) return fail(extra, `manual-url không có ${extra}`);
      const w = parseWhen(h.when, 'handshake.when');
      if ('bad' in w) return w;
      const e = field('urlField', h.urlField);
      if (e) return e;
      const av = afterVerifyOf(h.afterVerify);
      if (av === null) return fail('afterVerify', AFTER_VERIFY_MESSAGE);
      return { value: { kind: 'manual-url', when: w.value!, urlField: h.urlField, ...(av ? { afterVerify: true as const } : {}) } };
    }
  }
}

const AFTER_VERIFY_MESSAGE = 'afterVerify là true | false (true: chỉ trả lời bắt tay khi request bắt tay ký đúng theo cấu hình — Slack, Twitch)';
/** `afterVerify`: vắng/false -> false; true -> true; giá trị khác -> null (422). */
function afterVerifyOf(v: unknown): boolean | null {
  if (v === undefined || v === false) return false;
  return v === true ? true : null;
}

/**
 * Review PK4 TB-2: header bắt tay mà MỌI request của provider (hoặc mọi request HTTP) đều mang thì mọi sự kiện thật bị coi là
 * bắt tay: 200, không COMMIT, provider không gửi lại — mất sự kiện qua đường cấu hình (BB-3). Tập header "chung": do client
 * HTTP / proxy / Cloudflare tunnel gắn vào mọi request.
 */
export const COMMON_REQUEST_HEADERS: readonly string[] = [
  'accept',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'te',
  'transfer-encoding',
  'user-agent',
  'via',
  'x-real-ip',
];
/** Tiền tố header chung: `accept-*`, `x-forwarded-*`, `cf-*` (cloudflared gắn cf-ray, cf-connecting-ip…). */
export const COMMON_REQUEST_HEADER_PREFIXES: readonly string[] = ['accept-', 'x-forwarded-', 'cf-'];
/** Header của chuẩn Standard Webhooks (cả bộ Svix) — source standard-webhooks đọc chúng ở mọi sự kiện. */
const SW_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'svix-id', 'svix-timestamp', 'svix-signature'];

/** Header mà MỌI sự kiện của config mang: chữ ký, timestamp, id, khoá chống trùng (config đã kiểm khuôn). */
export function eventHeadersOf(c: Omit<GenericConfig, 'handshake'>): string[] {
  const out: string[] = [];
  if (c.header) out.push(c.header);
  if (c.scheme === 'static-token' && c.location === 'basic') out.push('authorization');
  if (c.scheme === 'standard-webhooks') out.push(...SW_HEADERS);
  if (c.signature) out.push(...('kv' in c.signature ? [c.signature.header] : c.signature.headers));
  if (c.timestampHeader) out.push(c.timestampHeader);
  if (c.idHeader) out.push(c.idHeader);
  if ('header' in c.idempotency) out.push(c.idempotency.header);
  return out;
}

export const isCommonRequestHeader = (h: string): boolean =>
  COMMON_REQUEST_HEADERS.includes(h) || COMMON_REQUEST_HEADER_PREFIXES.some((p) => h.startsWith(p));

/**
 * Review PK4 TB-2: bắt tay không được "nuốt" sự kiện thật. 422 khi header của `header-echo` hoặc `when.header` là header mọi
 * sự kiện của config mang (chữ ký/timestamp/id/khoá chống trùng) hoặc header chung; khi `when.field` trùng trường chống trùng.
 */
function handshakeConflict(c: GenericConfig): ConfigCheck | null {
  const h = c.handshake;
  if (!h) return null;
  const event = eventHeadersOf(c);
  const clash = (name: string) =>
    event.includes(name)
      ? `${name} là header mọi sự kiện của cấu hình này đều mang (chữ ký / timestamp / id / khoá chống trùng) — mọi sự kiện sẽ bị coi là bắt tay và mất`
      : isCommonRequestHeader(name)
        ? `${name} là header chung của mọi request HTTP — mọi sự kiện sẽ bị coi là bắt tay và mất`
        : null;
  if (h.kind === 'header-echo') {
    const m = clash(h.header);
    if (m) return bad('handshake.header', m);
  }
  if ('when' in h) {
    if ('header' in h.when) {
      const m = clash(h.when.header);
      if (m) return bad('handshake.when.header', m);
    } else if ('field' in c.idempotency && h.when.field === c.idempotency.field) {
      return bad('handshake.when.field', `${h.when.field} là trường chống trùng — mọi sự kiện đều mang; chọn trường chỉ request bắt tay mới có (vd type)`);
    }
  }
  return null;
}

/** PK4 §6.3: `ack` — successStatus 200|202|204, rejectStatus 401|403|503. 2xx khi từ chối = lối vòng qua EG2 -> 422. */
function parseAck(a: unknown): Parsed<AckConfig> {
  if (a === undefined) return {};
  if (!isObj(a)) return { bad: bad('ack', 'ack là {successStatus?, rejectStatus?}') };
  const extra = Object.keys(a).find((k) => k !== 'successStatus' && k !== 'rejectStatus');
  if (extra) return { bad: bad(`ack.${extra}`, `ack không có ${extra}`) };
  if (a.successStatus !== undefined && !(ACK_SUCCESS_STATUSES as readonly unknown[]).includes(a.successStatus)) {
    return { bad: bad('ack.successStatus', 'successStatus là 200 | 202 | 204') };
  }
  if (a.rejectStatus !== undefined && !(ACK_REJECT_STATUSES as readonly unknown[]).includes(a.rejectStatus)) {
    return {
      bad: bad('ack.rejectStatus', 'rejectStatus là 401 | 403 | 503 — KHÔNG BAO GIỜ 2xx (2xx cho request sai chữ ký là lối vòng qua hộp phạt EG2, BB-3)'),
    };
  }
  const value: AckConfig = {};
  if (a.successStatus !== undefined) value.successStatus = a.successStatus;
  if (a.rejectStatus !== undefined) value.rejectStatus = a.rejectStatus;
  return { value };
}


// ───────────────────────── PK3: signed-template (SPEC-provider-khac §5, E16, ADR-204) ─────────────────────────

/** Chỉ 3 token; thêm token = ADR kèm fixture provider thật. `{1,128}` đếm theo đơn vị (ký tự thường hoặc một token). */
export const TEMPLATE_RE = /^([^{}]|\{(timestamp|body|id)\}){1,128}$/;
export const TEMPLATE_ALGOS: readonly HmacAlgo[] = ['sha256', 'sha512'];
export const TIMESTAMP_FORMATS: readonly TimestampFormat[] = ['unix', 'unix-ms', 'iso8601'];
export const KV_SEPS = [';', ','] as const;
/** Tên khoá trong header khoá=giá trị (`t`, `v1`, `ts`, `h1`). */
export const KV_KEY_RE = /^[A-Za-z0-9_]{1,16}$/;
export const TOLERANCE_MIN_SEC = 5; // Paddle SDK chỉ chấp nhận lệch 5s (nghiên cứu §1.5)
export const TOLERANCE_MAX_SEC = 900;
export const SIGNATURE_HEADERS_MAX = 2; // E16: Box primary + secondary

/** Object chỉ có các khoá trong `allowed`. */
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const isTemplateScheme = (c: Pick<GenericConfig, 'scheme'>): boolean => c.scheme === TEMPLATE_SCHEME;

export type TemplatePart = { token: 'timestamp' | 'body' | 'id' } | { text: string };

/** Tách template (ĐÃ KIỂM) thành phần chữ và token, theo đúng thứ tự. */
export function templateParts(template: string): TemplatePart[] {
  return template
    .split(/(\{(?:timestamp|body|id)\})/)
    .filter((p) => p.length > 0)
    .map((p) => (/^\{(timestamp|body|id)\}$/.test(p) ? { token: p.slice(1, -1) as 'timestamp' | 'body' | 'id' } : { text: p }));
}

/** Số lần token xuất hiện trong template. */
export const countToken = (template: string, token: 'timestamp' | 'body' | 'id'): number => template.split(`{${token}}`).length - 1;

/**
 * PK3: `signed-template` — HMAC(algo, key, các phần của template nối bytes), `{body}` là bytes gốc. Luật (422 đúng tên trường):
 * - `template` khớp `TEMPLATE_RE`, `{body}` ĐÚNG một lần (không có thì chữ ký không phủ body -> giả mạo được);
 * - có `{timestamp}` -> bắt buộc nguồn timestamp (`timestampHeader` HOẶC `signature.kv.timestamp`, không cả hai) và
 *   `toleranceSec` 5..900 (không kiểm độ lệch thì phát lại được mãi); không có `{timestamp}` thì các trường đó bị cấm;
 * - có `{id}` <-> `idHeader`.
 */
function validateSignedTemplate(c: Record<string, any>): ConfigCheck {
  for (const f of ['header', 'prefix', 'location', 'param', 'algos'] as const) {
    if (c[f] !== undefined) return bad(f, `signed-template không có ${f} (chữ ký khai ở "signature")`);
  }
  if (typeof c.template !== 'string' || !TEMPLATE_RE.test(c.template)) {
    return bad('template', 'template ≤ 128 đơn vị, chỉ token {timestamp} {body} {id}, không dấu { } lẻ (vd "v0:{timestamp}:{body}")');
  }
  const template: string = c.template;
  if (countToken(template, 'body') !== 1) return bad('template', 'template phải có {body} đúng một lần (chữ ký phải phủ toàn bộ body)');
  const hasTs = countToken(template, 'timestamp') > 0;
  const hasId = countToken(template, 'id') > 0;
  // Review PK3 T-1 (ADR-204 bổ sung): `{id}` và `{body}` đều không có khuôn cố định — đứng sát nhau thì dời được byte qua
  // ranh giới (`evt-1` + `{"a":1}` = `evt-` + `1{"a":1}`) mà chữ ký vẫn đúng: body bị đổi, khoá chống trùng đổi. Bắt buộc
  // có ký tự ngăn cách. `{timestamp}` đứng sát thì an toàn vì khuôn cứng (unix/unix-ms không số 0 đứng đầu, ISO cố định)
  // + cửa sổ độ lệch: dời một byte đổi giá trị ≥ 10 lần hoặc làm hỏng khuôn (Twitch `{id}{timestamp}{body}` vẫn hợp lệ).
  if (template.includes('{id}{body}') || template.includes('{body}{id}')) {
    return bad('template', '{id} không được đứng sát {body} — thêm ký tự ngăn cách (vd "{id}.{body}")');
  }

  const algo: HmacAlgo = c.algo ?? 'sha256';
  if (!TEMPLATE_ALGOS.includes(algo)) return bad('algo', `algo của signed-template là ${TEMPLATE_ALGOS.join(' | ')}`);
  const encoding = c.encoding ?? 'hex';
  if (!ENCODINGS.includes(encoding)) return bad('encoding', 'encoding: hex | base64');
  const keyEncoding: KeyEncoding = c.keyEncoding ?? 'utf8';
  if (!KEY_ENCODINGS.includes(keyEncoding)) return bad('keyEncoding', 'keyEncoding: utf8 | hex | base64');

  const sig = c.signature;
  if (!isObj(sig)) return bad('signature', 'signature là {headers:[…], prefix?} HOẶC {header, kv:{sep, sig, timestamp?}}');
  let signature: SignatureLocation;
  let kvTimestamp: string | undefined;
  if ('kv' in sig) {
    if (!onlyKeys(sig, ['header', 'kv'])) return bad('signature', 'signature dạng kv chỉ có header + kv');
    if (typeof sig.header !== 'string' || !HEADER_RE.test(sig.header)) return bad('signature.header', 'header viết thường ^[a-z0-9-]{1,64}$');
    const kv = sig.kv;
    if (!isObj(kv) || Object.keys(kv).some((k) => !['sep', 'sig', 'timestamp'].includes(k))) return bad('signature.kv', 'kv là {sep, sig, timestamp?}');
    if (!(KV_SEPS as readonly unknown[]).includes(kv.sep)) return bad('signature.kv.sep', 'sep là ";" hoặc ","');
    if (typeof kv.sig !== 'string' || !KV_KEY_RE.test(kv.sig)) return bad('signature.kv.sig', 'sig là tên khoá ^[A-Za-z0-9_]{1,16}$ (vd v1, h1)');
    if (kv.timestamp !== undefined && (typeof kv.timestamp !== 'string' || !KV_KEY_RE.test(kv.timestamp) || kv.timestamp === kv.sig)) {
      return bad('signature.kv.timestamp', 'timestamp là tên khoá ^[A-Za-z0-9_]{1,16}$ khác sig (vd t, ts)');
    }
    kvTimestamp = kv.timestamp;
    signature = { header: sig.header, kv: { sep: kv.sep, sig: kv.sig, ...(kvTimestamp !== undefined ? { timestamp: kvTimestamp } : {}) } };
  } else {
    if (!onlyKeys(sig, ['headers', 'prefix'])) return bad('signature', 'signature dạng header chỉ có headers + prefix');
    const hs = sig.headers;
    if (
      !Array.isArray(hs) ||
      hs.length === 0 ||
      hs.length > SIGNATURE_HEADERS_MAX ||
      hs.some((h: unknown) => typeof h !== 'string' || !HEADER_RE.test(h)) ||
      new Set(hs).size !== hs.length
    ) {
      return bad('signature.headers', `headers là 1–${SIGNATURE_HEADERS_MAX} tên header viết thường, không trùng (khớp một là đủ)`);
    }
    if (sig.prefix !== undefined && (typeof sig.prefix !== 'string' || sig.prefix.length > PREFIX_MAX)) {
      return bad('signature.prefix', 'prefix là chuỗi ≤ 32 ký tự (vd "v0=", "sha256=")');
    }
    signature = { headers: [...hs], ...(typeof sig.prefix === 'string' && sig.prefix.length > 0 ? { prefix: sig.prefix } : {}) };
  }

  if (hasTs) {
    if (kvTimestamp !== undefined && c.timestampHeader !== undefined) return bad('timestampHeader', 'timestamp đã nằm trong signature.kv — bỏ timestampHeader');
    if (kvTimestamp === undefined && (typeof c.timestampHeader !== 'string' || !HEADER_RE.test(c.timestampHeader))) {
      return bad('timestampHeader', 'template có {timestamp}: cần timestampHeader (viết thường) hoặc signature.kv.timestamp');
    }
    if (c.timestampFormat !== undefined && !TIMESTAMP_FORMATS.includes(c.timestampFormat)) {
      return bad('timestampFormat', `timestampFormat là ${TIMESTAMP_FORMATS.join(' | ')}`);
    }
    const tol = c.toleranceSec;
    if (typeof tol !== 'number' || !Number.isInteger(tol) || tol < TOLERANCE_MIN_SEC || tol > TOLERANCE_MAX_SEC) {
      return bad('toleranceSec', `template có {timestamp}: toleranceSec bắt buộc, số nguyên ${TOLERANCE_MIN_SEC}..${TOLERANCE_MAX_SEC} giây`);
    }
  } else {
    if (kvTimestamp !== undefined) return bad('signature.kv.timestamp', 'template không có {timestamp}: bỏ signature.kv.timestamp');
    for (const f of ['timestampHeader', 'timestampFormat', 'toleranceSec'] as const) {
      if (c[f] !== undefined) return bad(f, `${f} chỉ dùng khi template có {timestamp}`);
    }
  }
  if (hasId) {
    if (typeof c.idHeader !== 'string' || !HEADER_RE.test(c.idHeader)) return bad('idHeader', 'template có {id}: idHeader bắt buộc, viết thường ^[a-z0-9-]{1,64}$');
  } else if (c.idHeader !== undefined) {
    return bad('idHeader', 'idHeader chỉ dùng khi template có {id}');
  }

  const tail = parseTail(c, false);
  if ('bad' in tail) return tail.bad;
  const config: GenericConfig = { scheme: TEMPLATE_SCHEME, template, algo, encoding, keyEncoding, signature, idempotency: tail.idempotency, eventType: tail.eventType };
  if (hasTs) {
    if (kvTimestamp === undefined) config.timestampHeader = c.timestampHeader;
    config.timestampFormat = c.timestampFormat ?? 'unix';
    config.toleranceSec = c.toleranceSec;
  }
  if (hasId) config.idHeader = c.idHeader;
  if (tail.mapping) config.mapping = tail.mapping;
  if (c.timezone !== undefined) config.timezone = c.timezone;
  if (tail.handshake) config.handshake = tail.handshake;
  if (tail.ack) config.ack = tail.ack;
  return handshakeConflict(config) ?? { ok: true, config };
}
