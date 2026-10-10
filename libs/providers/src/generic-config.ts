import { PAYMENT_TYPE_KEYS, isReservedType } from '@hub/common';

/**
 * Cấu hình GenericAdapter (`sources.verification_config`, SPEC §4.8 + §4.14.4). Kiểm lúc TẠO source — sai trả
 * 422 kèm tên trường. Không JSONPath, không dấu chấm: chỉ trường CẤP MỘT của body (John) — đọc được, bảo vệ được.
 */
export type GenericScheme = 'hmac-sha256' | 'static-token' | 'standard-webhooks';
export type MappingValue = string | { const: string | number };

export interface GenericConfig {
  scheme: GenericScheme;
  header?: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
  idempotency: { header: string } | { field: string };
  eventType: string;
  mapping?: Record<string, MappingValue>;
  timezone?: string;
}

export type ConfigCheck = { ok: true; config: GenericConfig } | { ok: false; field: string; message: string };

const SCHEMES: GenericScheme[] = ['hmac-sha256', 'static-token', 'standard-webhooks'];
/** Mẫu duy nhất có `encoding` (tách hằng: gate sig-compare cấm so sánh trên dòng nhắc tới hmac). */
const SCHEME_WITH_ENCODING: GenericScheme = 'hmac-sha256';
const ENCODINGS = ['hex', 'base64'];
const HEADER_RE = /^[a-z0-9-]{1,64}$/;
export const FIELD_RE = /^[A-Za-z0-9_]{1,64}$/;
const EVENT_TYPE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

/** Khoá ánh xạ được: phần lõi trừ `raw`/`counterparty`/`account` + khoá thời gian của kiểu (+ `reason` cho failed). */
const MAPPABLE_CORE = ['amount', 'currency', 'method', 'reference', 'memo', 'providerTxnId'];
const REQUIRED_CORE = ['amount', 'currency', 'method', 'providerTxnId'];

export function paymentTimeKey(eventType: string): string | null {
  return PAYMENT_TYPE_KEYS[eventType]?.[0] ?? null;
}

const bad = (field: string, message: string): ConfigCheck => ({ ok: false, field, message });
const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateGenericConfig(input: unknown): ConfigCheck {
  if (!isObj(input)) return bad('verificationConfig', 'provider generic bắt buộc có verificationConfig (object)');
  const c = input;
  if (!SCHEMES.includes(c.scheme)) return bad('scheme', `scheme là một trong ${SCHEMES.join(', ')}`);
  const scheme = c.scheme as GenericScheme;
  const sw = scheme === 'standard-webhooks';

  if (sw) {
    if (c.header !== undefined) return bad('header', 'standard-webhooks không có header (dùng webhook-id/timestamp/signature)');
    if (c.encoding !== undefined) return bad('encoding', 'standard-webhooks không có encoding');
  } else if (typeof c.header !== 'string' || !HEADER_RE.test(c.header)) {
    return bad('header', 'header bắt buộc, viết thường, ^[a-z0-9-]{1,64}$ (vd x-signature)');
  }
  if (c.encoding !== undefined && (scheme !== SCHEME_WITH_ENCODING || !ENCODINGS.includes(c.encoding))) {
    return bad('encoding', 'encoding chỉ cho hmac-sha256: hex | base64');
  }
  if (c.prefix !== undefined && (sw || typeof c.prefix !== 'string' || c.prefix.length > 32)) {
    return bad('prefix', 'prefix là chuỗi ≤ 32 ký tự (vd "sha256=", "Bearer "), không dùng với standard-webhooks');
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
  if (!sw) config.header = c.header;
  if (scheme === SCHEME_WITH_ENCODING) config.encoding = c.encoding ?? 'hex';
  if (c.prefix !== undefined) config.prefix = c.prefix;
  if (mapping) config.mapping = mapping;
  if (c.timezone !== undefined) config.timezone = c.timezone;
  return { ok: true, config };
}
