import { HubApiError } from "./client";

/**
 * ADR-242 — trạng thái + vòng nối lại của socket realtime, tách khỏi React/Socket.IO để test được (như auth-boot.ts).
 *
 *   connecting ──(connect)──▶ connected ──(rớt)──▶ connecting ──(đứt LIÊN TỤC ≥ REALTIME_RED_AFTER_MS)──▶ disconnected
 *        └──────────(vé bị từ chối thật: 401/403/4xx)─────────────────────────────────────────────▶ disconnected
 *
 * Hai lỗ của bản cũ (badge chỉ có xanh/đỏ theo `socket.connected`):
 *  1. Render free cold start (~80s, ADR-240) / redeploy -> đỏ "Mất kết nối" suốt lúc Socket.IO tự nối lại.
 *  2. Xin vé `/auth/socket-ticket` lỗi tạm thời (502 lúc cold start, timeout, mạng) -> `cb({})` -> server từ chối
 *     handshake `UNAUTHORIZED` -> Socket.IO client NHẬN CONNECT_ERROR thì `destroy()` (không tự nối lại sau lỗi
 *     middleware) -> đỏ mãi tới khi reload.
 * Ở đây: vé lỗi tạm thời -> KHÔNG gửi handshake, huỷ lượt nối và tự thử lại (backoff có trần + jitter); bị middleware từ
 * chối / server ngắt -> chủ động `connect()` lại (vé mới mỗi lượt — vé 60s, SPEC-auth §5.7); tab hiện lại / `online` -> thử ngay.
 */
export type RealtimeStatus = "connecting" | "connected" | "disconnected";

/**
 * ADR-242: chỉ báo đỏ khi đã đứt LIÊN TỤC quá ngưỡng này. = HUB_FETCH_TIMEOUT_MS (90s, ADR-238): phủ một lần cold start
 * Render free (~60–84s đo được, ADR-240) hoặc redeploy — trong khoảng đó server "đang khởi động", không phải "mất".
 */
export const REALTIME_RED_AFTER_MS = 90_000;
/** Backoff xin lại vé: 1s, 2s, 4s, 8s, trần 10s (đo probe ADR-242: trần 30s làm chậm ~10–15s sau khi server đã lên; 1 request/10s/tab là rẻ); jitter "equal" (một nửa cố định + một nửa ngẫu nhiên) để nhiều tab không dồn cục. */
export const TICKET_RETRY_BASE_MS = 1_000;
export const TICKET_RETRY_MAX_MS = 10_000;

/** Độ trễ trước lượt thử thứ `attempt` (0-based): trong [trần/2, trần], trần = min(MAX, BASE·2^attempt). */
export function ticketRetryDelay(attempt: number, random: () => number = Math.random): number {
  const ceil = Math.min(TICKET_RETRY_MAX_MS, TICKET_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.round(ceil / 2 + random() * (ceil / 2));
}

/**
 * Lỗi xin vé -> làm gì. Server chưa thức (timeout status 0, mạng, 5xx của proxy), 408, 429 = tạm thời -> thử lại.
 * 401 (hubFetch đã refresh hỏng và tự đưa về /login — luồng chuẩn) và 403/4xx khác (mất quyền vào project) = bị từ chối
 * thật -> đỏ ngay, không lặp xin vé vô ích.
 */
export function classifyTicketError(err: unknown): "transient" | "denied" {
  if (err instanceof HubApiError) {
    if (err.status === 0 || err.status >= 500 || err.status === 408 || err.status === 429) return "transient";
    return "denied";
  }
  return "transient"; // TypeError của fetch (mất mạng) …
}

/** Phần Socket.IO mà connector cần (Socket thật thoả sẵn). `active` = còn đăng ký với Manager (Socket.IO tự nối lại). */
export interface SocketLike {
  readonly active: boolean;
  connect(): unknown;
  disconnect(): unknown;
}

export interface ConnectorOptions {
  socket: SocketLike;
  /** Xin vé MỚI cho lượt nối này (project đọc lúc gọi). */
  fetchTicket: () => Promise<string>;
  onStatus: (status: RealtimeStatus) => void;
  /** Gọi `wake` khi tab hiện lại / có mạng lại; trả hàm gỡ. Mặc định: không nghe gì (test, SSR). */
  subscribeWake?: (wake: () => void) => () => void;
  random?: () => number;
  now?: () => number;
  redAfterMs?: number;
}

export interface RealtimeConnector {
  readonly status: RealtimeStatus;
  /** Gắn vào `io(url, { auth })`: Socket.IO gọi mỗi lần (re)connect. */
  auth: (cb: (data: { ticket: string }) => void) => void;
  handleConnect: () => void;
  handleDisconnect: (reason: string) => void;
  handleConnectError: () => void;
  /** Đổi project: bỏ lượt đang dở (vé của project cũ), nối lại với vé mới. */
  restart: () => void;
  /** Thử nối ngay (tab hiện lại / online) — bỏ qua nếu đang nối, đang xin vé, hoặc Socket.IO đang tự nối. */
  wake: () => void;
  /** Gỡ hết timer + listener; mọi handler sau đó là no-op. Caller tự `socket.disconnect()`. */
  dispose: () => void;
}

export function createRealtimeConnector(opts: ConnectorOptions): RealtimeConnector {
  const { socket, fetchTicket, onStatus, random = Math.random, now = Date.now, redAfterMs = REALTIME_RED_AFTER_MS } = opts;
  let status: RealtimeStatus = "connecting";
  let downSince: number | null = now();
  let redTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0; // số lượt nối hỏng liên tiếp (xin vé / middleware) — chỉ số backoff
  let generation = 0; // lượt `auth` hiện hành; vé về muộn của lượt cũ bị bỏ (không handshake hộ socket đã huỷ)
  let inflight = false;
  let disposed = false;

  const set = (s: RealtimeStatus) => {
    if (status === s) return;
    status = s;
    onStatus(s);
  };
  const clearRed = () => {
    if (redTimer) clearTimeout(redTimer);
    redTimer = null;
  };
  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const armRed = () => {
    if (redTimer || status === "disconnected" || downSince === null) return;
    const left = downSince + redAfterMs - now();
    if (left <= 0) return set("disconnected");
    redTimer = setTimeout(() => {
      redTimer = null;
      if (!disposed && status !== "connected") set("disconnected");
    }, left);
  };
  /** Bắt đầu (hoặc tiếp tục) một quãng đứt: đỏ chỉ khi quãng này kéo dài quá ngưỡng — không đếm lại từ đầu mỗi lượt thử. */
  const markDown = () => {
    if (downSince === null) downSince = now();
    if (status === "connected") set("connecting");
    armRed();
  };
  const scheduleRetry = () => {
    clearRetry();
    const delay = ticketRetryDelay(failures++, random);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!disposed) socket.connect();
    }, delay);
  };

  const unsubscribeWake = opts.subscribeWake?.(() => wake()) ?? (() => {});

  function wake() {
    if (disposed || status === "connected" || inflight || socket.active) return;
    clearRetry();
    socket.connect();
  }

  armRed();

  return {
    get status() {
      return status;
    },
    auth(cb) {
      if (disposed) return;
      const mine = ++generation;
      inflight = true;
      fetchTicket().then(
        (ticket) => {
          if (disposed || mine !== generation) return;
          inflight = false;
          cb({ ticket });
        },
        (err: unknown) => {
          if (disposed || mine !== generation) return;
          inflight = false;
          generation++;
          // Không gửi handshake vô vé (bản cũ `cb({})` -> UNAUTHORIZED -> Socket.IO huỷ socket, không tự nối lại).
          socket.disconnect();
          markDown();
          if (classifyTicketError(err) === "denied") {
            clearRetry();
            clearRed();
            set("disconnected");
            return;
          }
          scheduleRetry();
        },
      );
    },
    handleConnect() {
      if (disposed) return;
      failures = 0;
      downSince = null;
      clearRed();
      clearRetry();
      set("connected");
    },
    handleDisconnect(reason) {
      if (disposed) return;
      markDown();
      // Server chủ động ngắt (R-3: phiên/quyền đổi) -> Socket.IO KHÔNG tự nối lại. Nối lại với vé mới: còn quyền thì xanh,
      // hết phiên thì xin vé 401 -> hubFetch đưa về /login. "transport close"/"ping timeout" -> Socket.IO tự lo.
      if (reason === "io server disconnect") scheduleRetry();
    },
    handleConnectError() {
      if (disposed) return;
      markDown();
      // active = lỗi tầng engine (server chưa lên): Manager tự thử lại. !active = middleware từ chối -> socket đã bị huỷ.
      if (!socket.active) scheduleRetry();
    },
    restart() {
      if (disposed) return;
      generation++;
      inflight = false;
      clearRetry();
      socket.disconnect();
      // Ngữ cảnh mới (project khác): đếm quãng đứt + backoff lại từ đầu.
      failures = 0;
      downSince = null;
      clearRed();
      set("connecting");
      markDown();
      socket.connect();
    },
    wake,
    dispose() {
      disposed = true;
      generation++;
      clearRed();
      clearRetry();
      unsubscribeWake();
    },
  };
}
