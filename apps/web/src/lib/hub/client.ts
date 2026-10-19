import { createT, DEFAULT_LOCALE, isLocale, type TranslateFn } from "../i18n/dictionary";
import { waitForAuthGate } from "./auth-gate";
import { clearProjectSelection, currentProjectId } from "./project-store";
import { errorMessageOf } from "./ui-logic";

export class HubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
    /** `x-request-id` của hub (nối lỗi giao diện với log backend — LOGGING.md §11.9d). Chỉ để báo lỗi, không hiển thị. */
    readonly requestId?: string,
    /** `x-hub-cold: 1` — hub vừa thức dậy từ ngủ (Render free). */
    readonly cold?: boolean,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

/**
 * ADR-238: request quá `timeoutMs` — `status = 0` (không có phản hồi HTTP). Hub-api trên Render free ngủ sau 15 phút rảnh,
 * thức dậy mất ~30–60s: hạn mặc định phải dài hơn thế, nhưng không được treo vô hạn (trang chờ mãi, không nút thử lại).
 */
export class HubTimeoutError extends HubApiError {
  constructor(readonly timeoutMs: number) {
    super(0, uiT()("errors.api.timeout", { seconds: Math.round(timeoutMs / 1000) }));
    this.name = "HubTimeoutError";
  }
}

/** 90s: phủ một lần cold start của Render (~60s) + dư. Áp cho MỌI request — server cũng ngủ lúc tab đang mở. */
export const HUB_FETCH_TIMEOUT_MS = 90_000;

export interface HubFetchInit extends RequestInit {
  /** Hạn chờ (ms) cả header lẫn body; mặc định HUB_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Chỉ AuthGuard: đi qua cổng auth (ADR-238) — request của chính guard không thể chờ guard. */
  bypassAuthGate?: boolean;
}

/** fetch + đọc body trong hạn `timeoutMs`; `signal` của caller vẫn huỷ được (lỗi abort gốc, không phải timeout). */
async function fetchText(path: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; text: string }> {
  const ctrl = new AbortController();
  const outer = init.signal;
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(path, { ...init, signal: ctrl.signal });
    return { res, text: await res.text() };
  } catch (err) {
    if (timedOut) throw new HubTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/**
 * `t` theo ngôn ngữ giao diện ĐANG hiển thị: <html lang> do boot script đặt và useChangeLanguage cập nhật
 * (preference-runtime) — hubFetch không nằm trong cây React nên không dùng được useT().
 */
function uiT(): TranslateFn {
  const lang = typeof document === "undefined" ? null : document.documentElement.lang;
  return createT(isLocale(lang) ? lang : DEFAULT_LOCALE);
}

/** SPEC-auth §9: trang đăng nhập ở `/login` (đường `/auth/*` của web là proxy sang hub-api). */
export const LOGIN_PATH = "/login";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Cookie `hub_csrf` (không HttpOnly — cố ý, SPEC-auth §5.4). Token phiên thì HttpOnly: JS không bao giờ thấy. */
export function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("hub_csrf="));
  return m ? decodeURIComponent(m.slice("hub_csrf=".length)) : null;
}

function redirectToLogin() {
  if (typeof window !== "undefined" && window.location.pathname !== LOGIN_PATH) {
    window.location.replace(`${LOGIN_PATH}?expired=1`);
  }
}

/**
 * Refresh single-flight (SPEC-auth §9): nhiều request cùng gặp 401 thì chỉ MỘT `POST /auth/refresh`, các request
 * còn lại chờ chung kết quả. `refresh_race` (tab khác vừa xoay vòng — cookie đã mới) vẫn coi là thử lại được.
 */
let refreshing: Promise<boolean> | null = null;
/**
 * ADR-238: số lần refresh thành công. Guard gọi `/auth/me` + `/api/v1/projects` SONG SONG: request nào gặp 401 SAU khi
 * refresh của request kia đã xong (single-flight đã nhả) mà vẫn gửi bằng cookie cũ thì chỉ cần thử lại — không refresh lần
 * hai (xoay vòng refresh token thêm một lần vô ích, dễ thành `refresh_race`).
 */
let refreshGeneration = 0;
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const csrf = readCsrfCookie();
      const { res, text } = await fetchText(
        "/auth/refresh",
        { method: "POST", credentials: "include", headers: csrf ? { "x-csrf-token": csrf } : {} },
        HUB_FETCH_TIMEOUT_MS,
      );
      let body: { error?: string } = {};
      try {
        body = text ? (JSON.parse(text) as { error?: string }) : {};
      } catch {
        /* body không phải JSON */
      }
      const ok = res.ok || body.error === "refresh_race";
      if (ok) refreshGeneration++;
      return ok;
    } catch {
      return false;
    } finally {
      // Nhả sau một nhịp để các request đang chờ dùng chung kết quả này.
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

/**
 * Route KHÔNG theo project (server đánh dấu `@NoProjectScope`): danh sách project của mình; cảnh báo XUYÊN project của
 * operator (CB3 — lọc project bằng `?project=`, không phải `projectId`); tuỳ chọn gắn NGƯỜI (`/api/v1/me/*`).
 */
const UNSCOPED_PREFIXES = ["/api/v1/projects", "/api/v1/alerts", "/api/v1/me/"];

/**
 * AU3: mọi route `/api/v1/*` theo MỘT project (server: thiếu -> 400 project_required). Gắn project đang chọn nếu path
 * chưa có — trừ các route ở UNSCOPED_PREFIXES (route con của `/api/v1/projects` mang id trên path).
 */
export function scopeToProject(path: string, projectId: string | null = currentProjectId()): string {
  if (!projectId || !path.startsWith("/api/v1/") || UNSCOPED_PREFIXES.some((p) => path.startsWith(p)) || /[?&]projectId=/.test(path))
    return path;
  return `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;
}

/**
 * fetch tới hub-api QUA PROXY của chính web (`/api/*`, `/auth/*` → rewrites): cookie first-party, URL tương đối,
 * `credentials:'include'`, gắn `x-csrf-token` cho method thay đổi dữ liệu, gắn `projectId` đang chọn.
 * 401 → refresh một lần (single-flight) rồi thử lại request gốc; refresh hỏng → về `/login`.
 * ADR-238: chờ cổng auth khi AuthGuard đang xác nhận phiên; quá `timeoutMs` → HubTimeoutError (status 0).
 */
export async function hubFetch<T>(path: string, init: HubFetchInit = {}, retried = false): Promise<T> {
  const { timeoutMs = HUB_FETCH_TIMEOUT_MS, bypassAuthGate = false, ...reqInit } = init;
  // ADR-238: chờ AuthGuard xác nhận phiên + chọn project (hạn timeout tính từ lúc ĐI, không tính thời gian chờ cổng).
  if (!bypassAuthGate && !path.startsWith("/auth/")) await waitForAuthGate();
  path = scopeToProject(path);
  const headers = new Headers(reqInit.headers);
  if (reqInit.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (reqInit.method ?? "GET").toUpperCase();
  if (MUTATING.has(method)) {
    const csrf = readCsrfCookie();
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  const generation = refreshGeneration;
  const { res, text } = await fetchText(path, { ...reqInit, headers, credentials: "include" }, timeoutMs);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (res.status === 401) {
    if (!retried && (generation !== refreshGeneration || (await refreshSession()))) return hubFetch<T>(path, init, true);
    redirectToLogin();
    throw new HubApiError(401, uiT()("errors.api.session-invalid"), body, res.headers.get("x-request-id") ?? undefined);
  }
  if (!res.ok) {
    throw new HubApiError(
      res.status,
      errorMessageOf(body, uiT()) || `HTTP ${res.status}`,
      body,
      res.headers.get("x-request-id") ?? undefined,
      res.headers.get("x-hub-cold") === "1",
    );
  }
  return body as T;
}

export interface AuthMe {
  /** `locale` (DINH-CHINH D3) = ngôn ngữ đã lưu; `isOperator` = người vận hành hub (chuông/trang Cảnh báo, CB4). */
  user: { id: string; email: string; name: string; emailVerified: boolean; locale?: "vi" | "en"; isOperator?: boolean };
  memberships: { projectId: string; slug: string; name: string; environment: string; role: string }[];
}

/**
 * Đăng xuất: thu hồi phiên ở server (cookie bị xoá trong response). Lỗi mạng vẫn về /login. Quên project đang chọn
 * (lỗi "stale project": user sau — vd operator — không được thừa hưởng project của user trước).
 */
export async function logout(): Promise<void> {
  clearProjectSelection();
  try {
    await hubFetch("/auth/logout", { method: "POST" }, true);
  } catch {
    /* về login dù sao */
  }
}
