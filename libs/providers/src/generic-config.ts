import { PAYMENT_TYPE_KEYS, isReservedType } from '@hub/common';

/**
 * Cấu hình GenericAdapter (`sources.verification_config`, SPEC §4.8 + §4.14.4). Kiểm lúc TẠO source — sai trả
 * 422 kèm tên trường. Không JSONPath, không dấu chấm: chỉ trường CẤP MỘT của body (John) — đọc được, bảo vệ được.
 *
 * PK2 (SPEC-provider-khac §4, ADR-203): `hmac` là THAM SỐ của cùng một thuật toán HMAC trên bytes body — `algo`,
 * `encoding`, `prefix` (tĩnh, hoặc `"<algo>="` = thuật toán đọc từ tiền tố), `keyEncoding`. Không biểu thức, không
 * vòng lặp. `hmac-sha256` là bí danh cũ, đọc ra `{algo:"sha256", keyEncoding:"utf8"}` qua `hmacParams` — khuôn lưu
 * của source cũ KHÔNG đổi, hành vi không đổi. `static-token` thêm `location`: header | basic | query.
 */
export type GenericScheme = 'hmac' | 'hmac-sha256' | 'static-token' | 'standard-webhooks';
export type MappingValue = string | { const: string | number };
export type HmacAlgo = 'sha1' | 'sha256' | 'sha512';
export type KeyEncoding = 'utf8' | 'hex' | 'base64';
export type TokenLocation = 'header' | 'basic' | 'query';

export interface GenericConfig {
  scheme: GenericScheme;
  header?: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
  /** PK2: chỉ scheme `hmac` (bí danh cũ luôn sha256). Vắng khi `prefix` là `"<algo>="`. */
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
  idempotency: { header: string } | { field: string };
  eventType: string;
  mapping?: Record<string, MappingValue>;
  timezone?: string;
}

export type ConfigCheck = { ok: true; config: GenericConfig } | { ok: false; field: string; message: string };

const SCHEMES: GenericScheme[] = ['hmac', 'hmac-sha256', 'static-token', 'standard-webhooks'];
/**
 * Hai mẫu có `encoding` (tách hằng: gate sig-compare cấm `===`/`!==` trên dòng nhắc tới hmac). `LEGACY_SCHEME` là bí
 * danh cũ — giữ nguyên hành vi (sha256, khoá utf8, prefix tĩnh).
 */
const PARAM_SCHEME: GenericScheme = 'hmac';
const LEGACY_SCHEME: GenericScheme = 'hmac-sha256';
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
  if (key.toString('base64').replace(/=+$/, '') !== secret.replace(/=+$/, '')) return null;
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

  let idempotency: GenericConfig['idempotency'];
  if (c.idempotency === undefined && sw) {
    idempotency = { header: 'webhook-id' };
  } else {
    if (!isObj(c.idempotency)) return bad('idempotency', 'idempotency là {header} HOẶC {field}');
    const keys = Object.keys(c.idempotency);
    if (keys.length !== 1 || !['header', 'field'].includes(keys[0])) return bad('idempotency', 'idempotency có ĐÚNG MỘT trong header | field');
    if (keys[0] === 'header') {
      if (typeof c.idempotency.header !== 'string' || !HEADER_RE.test(c.idempotency.header)) {
        return bad('idempotency.header', 'header viết thường ^[a-z0-9-]{1,64}$');
      }
      idempotency = { header: c.idempotency.header };
    } else {
      if (typeof c.idempotency.field !== 'string' || !FIELD_RE.test(c.idempotency.field)) {
        return bad('idempotency.field', 'field là trường CẤP MỘT của body ^[A-Za-z0-9_]{1,64}$ (không JSONPath, không dấu chấm)');
      }
      idempotency = { field: c.idempotency.field };
    }
  }

  if (typeof c.eventType !== 'string' || c.eventType.length > 128 || !EVENT_TYPE_RE.test(c.eventType)) {
    return bad('eventType', 'eventType khớp ^[a-z0-9_]+(\\.[a-z0-9_]+)+$ (vd bank.transaction.received)');
  }
  const eventType: string = c.eventType;
  const timeKey = paymentTimeKey(eventType);

  if (c.timezone !== undefined && (typeof c.timezone !== 'string' || !OFFSET_RE.test(c.timezone))) {
    return bad('timezone', 'timezone dạng ±hh:mm (vd +07:00)');
  }

  let mapping: GenericConfig['mapping'];
  if (c.mapping === undefined) {
    // Luật 4 §4.14.1: kiểu dành riêng (payment.*, repo.*) mà không ánh xạ thì data không thể đúng khuôn.
    if (isReservedType(eventType)) return bad('mapping', `${eventType} là kiểu chuẩn: bắt buộc có mapping`);
  } else {
    if (!timeKey) return bad('mapping', 'mapping chỉ dùng cho payment.received | payment.sent | payment.failed | payment.refunded');
    if (!isObj(c.mapping)) return bad('mapping', 'mapping là object');
    const allowed = [...MAPPABLE_CORE, timeKey, ...(eventType === 'payment.failed' ? ['reason'] : [])];
    for (const [k, v] of Object.entries(c.mapping)) {
      if (!allowed.includes(k)) return bad(`mapping.${k}`, `khoá không ánh xạ được; cho phép: ${allowed.join(', ')}`);
      const okField = typeof v === 'string' && FIELD_RE.test(v);
      const okConst = isObj(v) && Object.keys(v).length === 1 && (typeof v.const === 'string' || typeof v.const === 'number');
      if (!okField && !okConst) return bad(`mapping.${k}`, 'giá trị là tên trường CẤP MỘT (^[A-Za-z0-9_]{1,64}$) hoặc {"const": chuỗi|số}');
    }
    for (const k of [...REQUIRED_CORE, timeKey]) {
      if (!(k in c.mapping)) return bad(`mapping.${k}`, `mapping thiếu trường bắt buộc ${k}`);
    }
    mapping = c.mapping as Record<string, MappingValue>;
  }

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
  return { ok: true, config };
}
