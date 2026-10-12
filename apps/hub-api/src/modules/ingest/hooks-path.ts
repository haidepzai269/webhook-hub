import { createRequire } from 'module';
import type { IncomingMessage } from 'http';

/**
 * Path của request ĐÚNG như router của Nest (Express 5 -> gói `router`) nhìn thấy: `parseurl(req).pathname`.
 * Dùng chung cho mọi lớp đứng TRƯỚC router mà phải ra cùng kết luận với router (gate hộp phạt D3; sau rebase:
 * `rejectNonCanonicalHooksPath` của nhánh nginx). Tự tách bằng `originalUrl.split('?')` là lệch router: `#frag`,
 * absolute-form `http://h/hooks/...` (review EG lượt 6, TB-1).
 *
 * `parseurl` lấy từ ĐÚNG bản mà `router` của `@nestjs/platform-express` dùng (không thêm dependency, không lệch phiên bản);
 * nó cache kết quả trên `req._parsedUrl` — router đã parse rồi thì đây là tra cache.
 */
type ParseUrl = (req: { url?: string }) => { pathname?: string | null } | undefined;

function loadParseurl(): ParseUrl {
  try {
    const fromNest = createRequire(require.resolve('@nestjs/platform-express'));
    const fromExpress = createRequire(fromNest.resolve('express'));
    const fromRouter = createRequire(fromExpress.resolve('router'));
    return fromRouter('parseurl') as ParseUrl;
  } catch {
    return require('parseurl') as ParseUrl;
  }
}

const parseurl: ParseUrl = loadParseurl();

/** Pathname (chưa decode) như router thấy; không có `url` -> undefined. */
export function hooksPathOf(req: Pick<IncomingMessage, 'url'>): string | undefined {
  if (!req.url) return undefined;
  return parseurl(req)?.pathname ?? undefined;
}

/** Như `hooksPathOf` cho một request-target thô (test, công cụ). */
export function pathnameOfUrl(url: string | undefined): string | undefined {
  return url ? hooksPathOf({ url } as IncomingMessage) : undefined;
}

export interface HookRouteMatch {
  /** Đoạn 1 sau route, đã decode — có thể viết hoa / không phải provider đã đăng ký (router vẫn khớp). */
  provider: string;
  /** Đoạn 2 sau route, đã decode như `@Param()` — KHÔNG kiểm khuôn (ingest bước 0 cũng không). */
  sourceKey: string;
}

/**
 * Khớp `<route>/:provider/:sourceKey` trên pathname GIỐNG router Express 5 (`path-to-regexp` v8, không strict, không phân
 * biệt hoa thường): tiền tố route không phân biệt hoa thường, chấp nhận MỘT `/` cuối, đúng 2 đoạn khác rỗng, mỗi đoạn
 * `decodeURIComponent` một lần. `%xx` hỏng -> null (router trả 400). Route lồng nhau: thử route tiếp theo.
 */
export function matchHookRoute(pathname: string | undefined, routes: readonly string[]): HookRouteMatch | null {
  if (!pathname) return null;
  let path = pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const lower = path.toLowerCase();
  for (const route of routes) {
    const r = route.toLowerCase();
    if (!lower.startsWith(r + '/')) continue;
    const segs = path.slice(r.length + 1).split('/');
    if (segs.length !== 2 || !segs[0] || !segs[1]) continue;
    try {
      return { provider: decodeURIComponent(segs[0]), sourceKey: decodeURIComponent(segs[1]) };
    } catch {
      return null;
    }
  }
  return null;
}
