import { clearProjectSelection, currentProjectId } from "./project-store";
import { errorMessageOf } from "./ui-logic";

export class HubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "HubApiError";
  }
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
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const csrf = readCsrfCookie();
      const res = await fetch("/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: csrf ? { "x-csrf-token": csrf } : {},
      });
      if (res.ok) return true;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error === "refresh_race";
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
 * AU3: mọi route `/api/v1/*` theo MỘT project (server: thiếu -> 400 project_required). Gắn project đang chọn nếu path
 * chưa có — trừ `/api/v1/projects` (liệt kê/tạo của chính mình; route con mang id trên path).
 */
export function scopeToProject(path: string, projectId: string | null = currentProjectId()): string {
  if (!projectId || !path.startsWith("/api/v1/") || path.startsWith("/api/v1/projects") || /[?&]projectId=/.test(path))
    return path;
  return `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;
}

/**
 * fetch tới hub-api QUA PROXY của chính web (`/api/*`, `/auth/*` → rewrites): cookie first-party, URL tương đối,
 * `credentials:'include'`, gắn `x-csrf-token` cho method thay đổi dữ liệu, gắn `projectId` đang chọn.
 * 401 → refresh một lần (single-flight) rồi thử lại request gốc; refresh hỏng → về `/login`.
 */
export async function hubFetch<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  path = scopeToProject(path);
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (MUTATING.has(method)) {
    const csrf = readCsrfCookie();
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  const res = await fetch(path, { ...init, headers, credentials: "include" });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (res.status === 401) {
    if (!retried && (await refreshSession())) return hubFetch<T>(path, init, true);
    redirectToLogin();
    throw new HubApiError(401, "Phiên đăng nhập đã hết hạn hoặc không hợp lệ.", body);
  }
  if (!res.ok) {
    throw new HubApiError(res.status, errorMessageOf(body) || `HTTP ${res.status}`, body);
  }
  return body as T;
}

export interface AuthMe {
  user: { id: string; email: string; name: string; emailVerified: boolean };
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
