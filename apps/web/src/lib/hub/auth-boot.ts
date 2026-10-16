import { closeAuthGate, openAuthGate } from "./auth-gate";
import { type AuthMe, HubApiError, type HubFetchInit, hubFetch } from "./client";
import type { ProjectSummary } from "./flow-project";

/**
 * ADR-238 — vòng khởi động của AuthGuard, tách khỏi React để test được.
 *
 *   pending ──(5s chưa xong)──▶ slow ──┬─▶ ok       (đã chọn project, mở cổng hubFetch)
 *      └───────────────────────────────┼─▶ failed   (timeout / mạng / 5xx: nút Thử lại — KHÔNG về /login)
 *                                      └─▶ login    (401 sau refresh, 4xx khác: như cũ — về /login)
 */
export type BootPhase = "pending" | "slow" | "failed" | "ok";

export interface BootSession {
  me: AuthMe;
  projects: ProjectSummary[];
}

/** Sau 5s chưa có phiên -> hiện "máy chủ đang khởi động" (Render free cold start ~30–60s). */
export const SLOW_NOTICE_MS = 5_000;

type Fetcher = <T>(path: string, init?: HubFetchInit) => Promise<T>;

/**
 * `/auth/me` và `/api/v1/projects` SONG SONG (trước đây tuần tự — mỗi vòng cold start nhân đôi). Không suy danh sách từ
 * `me.memberships`: operator thấy MỌI project (member=false) mà memberships không có. Request project đi qua cổng —
 * chính nó là điều kiện mở cổng.
 */
export async function loadSession(fetcher: Fetcher = hubFetch): Promise<BootSession> {
  const [me, projects] = await Promise.all([
    fetcher<AuthMe>("/auth/me"),
    fetcher<ProjectSummary[]>("/api/v1/projects", { bypassAuthGate: true }),
  ]);
  return { me, projects };
}

/**
 * Lỗi khởi động -> làm gì. Server chưa thức (timeout status 0, mạng, 502/503/504 của proxy) KHÔNG phải "chưa đăng nhập":
 * đá về /login lúc đó là sai (login cũng sẽ treo). 401 (hubFetch đã thử refresh) và 4xx khác giữ hành vi cũ.
 */
export function bootFailureAction(err: unknown): "login" | "retry" {
  if (err instanceof HubApiError) return err.status === 0 || err.status >= 500 ? "retry" : "login";
  return "retry";
}

export interface BootCallbacks {
  onPhase: (phase: BootPhase) => void;
  /** Gọi TRƯỚC khi mở cổng: chọn project + nạp `me` để request đang chờ đi với đúng `?projectId=`. */
  onReady: (session: BootSession) => void;
  onLogin: () => void;
}

/** Chạy một lượt khởi động; trả hàm huỷ (effect cleanup) — huỷ thì không gọi callback nào nữa, cổng giữ nguyên. */
export function runBoot(
  cb: BootCallbacks,
  load: () => Promise<BootSession> = loadSession,
  slowMs = SLOW_NOTICE_MS,
): () => void {
  let alive = true;
  closeAuthGate();
  cb.onPhase("pending");
  const slow = setTimeout(() => alive && cb.onPhase("slow"), slowMs);
  load()
    .then((session) => {
      if (!alive) return;
      cb.onReady(session);
      openAuthGate();
      cb.onPhase("ok");
    })
    .catch((err: unknown) => {
      if (!alive) return;
      if (bootFailureAction(err) === "login") cb.onLogin();
      else cb.onPhase("failed");
    })
    .finally(() => clearTimeout(slow));
  return () => {
    alive = false;
    clearTimeout(slow);
  };
}
