import pino, { DestinationStream, Logger } from 'pino';
import { LOG_REDACT_OPTIONS, MIN_SECRET_MATCH_LEN, scrubSecrets } from './auth/redact';
import { errInfo } from './log-line';

/** Lỗi -> {class, message, stack, code, meta} đã scrub. Prisma: KHÔNG lấy message/stack nguyên văn (chứa tham số truy vấn) — chỉ code + model (§5). */
function scrubError(e: Error, depth: number): Record<string, unknown> {
  const x = e as Error & { code?: unknown; meta?: unknown };
  const info = errInfo(e);
  const out: Record<string, unknown> = { class: info.class, message: info.msg }; // khoá `class` (không phải `type`): serializer `err` của pino ghi đè `type` bằng tên lớp của object thuần
  if (info.code !== 'UNKNOWN') out.code = info.code;
  if (!info.class.startsWith('PrismaClient')) {
    if (typeof x.stack === 'string') out.stack = scrubSecrets(x.stack.slice(0, 4000));
  } else if (x.meta && typeof x.meta === 'object') out.meta = scrubDeep(x.meta, depth + 1);
  // Nguyên nhân gốc (vd `fetch failed` <- ECONNRESET; khoá `causedBy` vì serializer `err` của pino bỏ khoá `cause` của object thuần): đi qua scrubDeep cấp +1; trần sâu 8 chặn cause vòng.
  if (x.cause !== undefined && x.cause !== null) out.causedBy = scrubDeep(x.cause, depth + 1);
  return out;
}

/**
 * Scrub đệ quy chuỗi ở mọi cấp. Trần: sâu 8 (phần vượt thay bằng '[deep]', KHÔNG giữ nguyên), 60 phần tử/mảng, 200 khoá/object
 * (phần dư thay bằng dấu '[truncated N]'). Error -> scrubError; Buffer/Map/Set -> nhãn; Date -> ISO; lớp lạ khác duyệt như object (own enumerable).
 */
export function scrubDeep(v: unknown, depth: number): unknown {
  // Logging không bao giờ được ném (getter ném, Proxy ném/đã revoke, Error có getter ném): lỗi ở nhánh nào thì nhánh đó thành nhãn.
  try {
    return scrubNode(v, depth);
  } catch {
    return '[unserializable]';
  }
}

function scrubNode(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > 4000 ? scrubSecrets(v.slice(0, 4000)) : scrubSecrets(v);
  if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' ? `[${typeof v}]` : v;
  if (depth >= 8) return '[deep]';
  if (v instanceof Error) return scrubError(v, depth);
  if (Buffer.isBuffer(v)) return `[Buffer ${v.length} bytes]`;
  if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.byteLength} bytes]`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '[Invalid Date]' : v.toISOString();
  if (v instanceof Map || v instanceof Set) return `[${v.constructor.name} ${v.size}]`;
  if (Array.isArray(v)) {
    const out = v.slice(0, 60).map((x) => scrubDeep(x, depth + 1));
    if (v.length > 60) out.push(`[truncated ${v.length - 60}]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const k in v as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    if (n++ >= 200) {
      out.__truncated = `[truncated more keys]`;
      break;
    }
    out[k.length < MIN_SECRET_MATCH_LEN ? k : scrubSecrets(k)] = scrubDeep((v as Record<string, unknown>)[k], depth + 1);
  }
  return out;
}

function stringifySafe(a: unknown): string {
  try {
    const j = typeof a === 'object' && a !== null ? JSON.stringify(scrubDeep(a, 0)) : String(a);
    return scrubSecrets(j ?? String(a));
  } catch {
    return '[unserializable]';
  }
}

function errText(e: Error): string {
  try {
    const i = errInfo(e);
    return `${i.class}: ${i.msg}`;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Đối số đầu là Error: pino lấy `msg` từ err.message (thô) -> chuyển thành `{err}` + msg đã scrub. Đối số format (vị trí >= 1 so với msg):
 * chuỗi -> scrubSecrets; Error -> `${class}: ${message}` đã scrub; object/mảng -> scrubDeep. Đối số object đầu (merge) đã qua formatters.log.
 */
function scrubArgs(args: unknown[]): unknown[] {
  let a = args;
  if (a[0] instanceof Error) a = [{ err: a[0] }, typeof a[1] === 'string' ? a[1] : errText(a[0]), ...a.slice(2)];
  return a.map((x, i) => {
    if (typeof x === 'string') return scrubSecrets(x);
    if (i === 0 || x === null || typeof x !== 'object') return x;
    return x instanceof Error ? scrubSecrets(errText(x)) : scrubDeep(x, 0);
  });
}

/** Gốc của formatters phải là object — nếu scrubDeep trả nhãn (gốc không đọc được) thì ghi object rỗng có dấu. */
function scrubTop(o: Record<string, unknown>): Record<string, unknown> {
  const r = scrubDeep(o, 0);
  return r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : { scrub: '[unserializable]' };
}

/**
 * LOGGING.md §3.1: `svc` (`hub-api` | `hub-worker`) ở MỌI dòng. Đặt MỘT lần ở `main.ts` của từng tiến trình
 * (`setServiceName`) — `mixin` đọc lúc ghi nên không cần tạo lại logger (các module đã import `logger` ở top-level).
 * Lệch thiết kế: LOGGING.md ghi "base của logger"; `base` bị cố định lúc tạo pino nên dùng `mixin` (ADR-254).
 */
let serviceName: string | undefined;
export function setServiceName(name: 'hub-api' | 'hub-worker'): void {
  serviceName = name;
}

/** Cấu hình pino của hub — tách ra để test dựng logger ghi vào luồng bắt log (bãi mìn §5) với ĐÚNG redact/scrub. */
export function createLogger(destination?: DestinationStream): Logger {
  const opts = {
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label: string) => ({ level: label }),
      // LOGGING.md §5: scrub CHUỖI ở mọi cấp của object/mảng (logMethod chỉ lo tham số string cấp 1) — lưới an toàn thứ hai.
      log: (obj: Record<string, unknown>) => scrubTop(obj),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // ADR-051 + SPEC-auth UA22: lưới an toàn — header nhạy cảm, khoá `password`/`token`… bị che theo TÊN KHOÁ;
    // chuỗi thông điệp được quét thêm (`hk_live_…`, cookie phiên, Bearer) vì bí mật có thể nằm giữa câu.
    redact: LOG_REDACT_OPTIONS,
    mixin: () => (serviceName ? { svc: serviceName } : {}),
    hooks: {
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        // Logging không bao giờ ném. Lần 1: đối số đã scrub; nếu pino vẫn ném (vd `%s` với object có toString ném) -> lần 2 chỉ còn chuỗi an toàn.
        let safe: unknown[];
        try {
          safe = scrubArgs(args);
        } catch {
          safe = ['[unserializable]'];
        }
        try {
          return method.apply(this, safe);
        } catch {
          try {
            return method.apply(this, safe.map((a, i) => (typeof a === 'string' || (i === 0 && typeof a === "object") ? a : stringifySafe(a))));
          } catch {
            return;
          }
        }
      },
    },
  };
  return scrubChildren((destination ? pino(opts as any, destination) : pino(opts as any)) as Logger);
}

/**
 * pino reset `formatters.bindings` cho child nên bindings của `child({...})`/`setBindings({...})` không qua formatters.
 * Bọc MỘT lần trên logger gốc; con tạo bằng `Object.create(this)` kế thừa bản bọc và gọi `child` GỐC của pino với đúng `this`
 * (không `bind` vào cha — nếu không con của con mất bindings của cha).
 */
function scrubChildren(l: Logger): Logger {
  const origChild = l.child as (this: Logger, b: Record<string, unknown>, o?: unknown) => Logger;
  const origSet = l.setBindings as (this: Logger, b: Record<string, unknown>) => void;
  (l as any).child = function (this: Logger, b: Record<string, unknown>, o?: unknown): Logger {
    return origChild.call(this, scrubTop(b), o);
  };
  (l as any).setBindings = function (this: Logger, b: Record<string, unknown>): void {
    origSet.call(this, scrubTop(b));
  };
  return l;
}

export const logger = createLogger();

export function createLoggerWithContext(context: Record<string, any>) {
  return logger.child(context);
}
