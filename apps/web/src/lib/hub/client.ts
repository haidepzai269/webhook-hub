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
  const m = document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("hub_csrf="));
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
 * fetch tới hub-api QUA PROXY của chính web (`/api/*`, `/auth/*` → rewrites): cookie first-party, URL tương đối,
 * `credentials:'include'`, gắn `x-csrf-token` cho method thay đổi dữ liệu. 401 → refresh một lần (single-flight)
 * rồi thử lại request gốc; refresh hỏng → về `/login`.
 */
export async function hubFetch<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
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
    const apiMessage =
      body !== null && typeof body === "object" && "message" in body ? (body as { message: unknown }).message : null;
    const message = Array.isArray(apiMessage) ? apiMessage.join(", ") : apiMessage ? String(apiMessage) : "";
    throw new HubApiError(res.status, message || `HTTP ${res.status}`, body);
  }
  return body as T;
}

export interface AuthMe {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  memberships: { projectId: string; slug: string; name: string; environment: string; role: string }[];
}

/** Đăng xuất: thu hồi phiên ở server (cookie bị xoá trong response). Lỗi mạng vẫn về /login. */
export async function logout(): Promise<void> {
  try {
    await hubFetch("/auth/logout", { method: "POST" }, true);
  } catch {
    /* về login dù sao */
  }
}
