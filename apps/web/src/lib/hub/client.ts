import { HUB_API_URL } from "@/lib/env";

import { clearToken, getToken } from "./token";

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

export const LOGIN_PATH = "/auth/login";

function redirectToLogin() {
  if (typeof window !== "undefined" && window.location.pathname !== LOGIN_PATH) {
    window.location.replace(`${LOGIN_PATH}?expired=1`);
  }
}

/**
 * fetch tới hub-api: gắn `Authorization: Bearer`, parse JSON, ném `HubApiError` khi !ok.
 * 401 → xoá token và quay về màn login (token hết hạn/sai, không nuốt lỗi im lặng).
 */
export async function hubFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const res = await fetch(`${HUB_API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (res.status === 401) {
    clearToken();
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
