import { HubApiError, HubTimeoutError } from "./client";
import {
  classifyTicketError,
  createRealtimeConnector,
  REALTIME_RED_AFTER_MS,
  type RealtimeStatus,
  type SocketLike,
  TICKET_RETRY_MAX_MS,
  ticketRetryDelay,
} from "./realtime-connector";

/**
 * ADR-242 — badge realtime đỏ suốt lúc Render cold start (~80s), và tệ hơn: xin vé `/auth/socket-ticket` lỗi (502/timeout)
 * thì `cb({})` -> server UNAUTHORIZED -> Socket.IO client huỷ socket sau CONNECT_ERROR, không tự nối lại -> đỏ mãi tới reload.
 * Socket giả mô phỏng đúng hành vi socket.io-client 4.8: `connect()` -> (engine mở) -> gọi `auth(cb)`; `cb` -> server quyết.
 */

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

class FakeSocket implements SocketLike {
  active = false;
  connectCalls = 0;
  disconnectCalls = 0;
  /** Mỗi lượt `connect()`: engine mở thì Socket.IO gọi auth — test gắn vào connector. */
  onOpen: () => void = () => {};
  connect() {
    this.connectCalls++;
    this.active = true;
    this.onOpen();
  }
  disconnect() {
    this.disconnectCalls++;
    this.active = false;
  }
}

function setup(ticket: () => Promise<string>) {
  const socket = new FakeSocket();
  const statuses: RealtimeStatus[] = [];
  const handshakes: { ticket: string }[] = [];
  let wake: (() => void) | null = null;
  let wakeSubscribed = false;
  const c = createRealtimeConnector({
    socket,
    fetchTicket: ticket,
    onStatus: (s) => statuses.push(s),
    random: () => 0.5,
    subscribeWake: (fn) => {
      wake = fn;
      wakeSubscribed = true;
      return () => {
        wakeSubscribed = false;
      };
    },
  });
  socket.onOpen = () => c.auth((data) => handshakes.push(data));
  return { socket, c, statuses, handshakes, wake: () => wake?.(), isWakeSubscribed: () => wakeSubscribed };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("ticketRetryDelay / classifyTicketError", () => {
  it("backoff mũ 2 có trần 10s, jitter nằm trong [trần/2, trần]", () => {
    expect(ticketRetryDelay(0, () => 0)).toBe(500);
    expect(ticketRetryDelay(0, () => 1)).toBe(1000);
    expect(ticketRetryDelay(3, () => 1)).toBe(8000);
    expect(ticketRetryDelay(20, () => 1)).toBe(TICKET_RETRY_MAX_MS);
    expect(ticketRetryDelay(1e6, () => 0)).toBe(TICKET_RETRY_MAX_MS / 2);
  });

  it("5xx/timeout/mạng/429 = tạm thời; 401/403/404 = bị từ chối thật", () => {
    expect(classifyTicketError(new HubApiError(502, "bad gateway"))).toBe("transient");
    expect(classifyTicketError(new HubTimeoutError(90_000))).toBe("transient");
    expect(classifyTicketError(new TypeError("Failed to fetch"))).toBe("transient");
    expect(classifyTicketError(new HubApiError(429, "slow down"))).toBe("transient");
    expect(classifyTicketError(new HubApiError(401, "session"))).toBe("denied");
    expect(classifyTicketError(new HubApiError(403, "forbidden"))).toBe("denied");
    expect(classifyTicketError(new HubApiError(404, "project"))).toBe("denied");
  });
});

describe("createRealtimeConnector — ba mức, không đỏ trong cold start", () => {
  it("cold start: engine lỗi liên tục 80s rồi server lên -> xám suốt, KHÔNG BAO GIỜ đỏ, rồi xanh", async () => {
    const { socket, c, statuses } = setup(() => Promise.resolve("t"));
    expect(c.status).toBe("connecting");
    socket.onOpen = () => {}; // engine chưa mở được: Socket.IO (active) tự thử lại, auth chưa được gọi
    socket.connect();
    for (let t = 0; t < 80_000; t += 5_000) {
      c.handleConnectError(); // lỗi tầng engine, socket.active = true
      jest.advanceTimersByTime(5_000);
    }
    expect(c.status).toBe("connecting");
    c.handleConnect();
    await flush();
    expect(statuses).toEqual(["connected"]);
    expect(statuses).not.toContain("disconnected");
  });

  it("redeploy giữa chừng: connected -> rớt -> xám -> nối lại -> xanh; quãng đứt mới được đếm lại từ đầu", () => {
    const { c, statuses } = setup(() => Promise.resolve("t"));
    c.handleConnect();
    c.handleDisconnect("transport close");
    jest.advanceTimersByTime(REALTIME_RED_AFTER_MS - 1);
    c.handleConnect();
    c.handleDisconnect("transport close");
    jest.advanceTimersByTime(REALTIME_RED_AFTER_MS - 1);
    expect(c.status).toBe("connecting");
    expect(statuses).toEqual(["connected", "connecting", "connected", "connecting"]);
  });

  it("đứt LIÊN TỤC quá ngưỡng -> đỏ; nối được lại -> xanh", () => {
    const { socket, c } = setup(() => Promise.resolve("t"));
    socket.onOpen = () => {};
    socket.connect();
    c.handleConnectError();
    jest.advanceTimersByTime(REALTIME_RED_AFTER_MS - 1);
    expect(c.status).toBe("connecting");
    jest.advanceTimersByTime(1);
    expect(c.status).toBe("disconnected");
    c.handleConnect();
    expect(c.status).toBe("connected");
  });

  it("vé 502 -> không handshake vô vé, tự xin lại có backoff (vé MỚI mỗi lượt) -> connected", async () => {
    let calls = 0;
    const { socket, c, handshakes } = setup(() => {
      calls++;
      return calls <= 3 ? Promise.reject(new HubApiError(502, "bad gateway")) : Promise.resolve(`ticket-${calls}`);
    });
    socket.connect();
    await flush();
    expect(handshakes).toEqual([]); // KHÔNG cb({}) như bản cũ
    expect(socket.disconnectCalls).toBe(1); // huỷ lượt nối đang dở
    expect(socket.active).toBe(false);
    jest.advanceTimersByTime(750); // lượt 0: 1s × (0.5 + 0.5·0.5)
    await flush();
    expect(calls).toBe(2);
    jest.advanceTimersByTime(1_500); // lượt 1: 2s × 0.75
    await flush();
    expect(calls).toBe(3);
    jest.advanceTimersByTime(3_000); // lượt 2: 4s × 0.75
    await flush();
    expect(calls).toBe(4);
    expect(handshakes).toEqual([{ ticket: "ticket-4" }]);
    c.handleConnect();
    expect(c.status).toBe("connected");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("vé 502 kéo dài cả cold start: không đỏ trước ngưỡng dù backoff chạm trần", async () => {
    const { socket, c, statuses } = setup(() => Promise.reject(new HubApiError(503, "waking")));
    socket.connect();
    let elapsed = 0;
    while (elapsed < REALTIME_RED_AFTER_MS - 1_000) {
      await flush();
      jest.advanceTimersByTime(1_000);
      elapsed += 1_000;
    }
    expect(statuses).not.toContain("disconnected");
    expect(c.status).toBe("connecting");
  });

  it("middleware từ chối (connect_error khi !active, vd. vé hết hạn) -> chủ động connect() lại với vé mới", async () => {
    let n = 0;
    const { socket, c, handshakes } = setup(() => Promise.resolve(`v${++n}`));
    socket.connect();
    await flush();
    expect(handshakes).toEqual([{ ticket: "v1" }]);
    socket.active = false; // socket.io-client: CONNECT_ERROR -> destroy()
    c.handleConnectError();
    jest.advanceTimersByTime(750);
    await flush();
    expect(socket.connectCalls).toBe(2);
    expect(handshakes).toEqual([{ ticket: "v1" }, { ticket: "v2" }]);
  });

  it("server chủ động ngắt (io server disconnect) -> tự nối lại (vé mới quyết định)", async () => {
    const { socket, c } = setup(() => Promise.resolve("t"));
    c.handleConnect();
    socket.active = false;
    c.handleDisconnect("io server disconnect");
    expect(c.status).toBe("connecting");
    jest.advanceTimersByTime(750);
    expect(socket.connectCalls).toBe(1);
  });

  it("vé 401 (hubFetch đã đưa về /login) / 403 -> đỏ ngay, không lặp xin vé", async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const { socket, c, handshakes } = setup(() => {
        calls++;
        return Promise.reject(new HubApiError(status, "denied"));
      });
      socket.connect();
      await flush();
      expect(c.status).toBe("disconnected");
      expect(handshakes).toEqual([]);
      jest.advanceTimersByTime(10 * TICKET_RETRY_MAX_MS);
      await flush();
      expect(calls).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
      c.dispose();
    }
  });

  it("tab hiện lại / online -> thử ngay, bỏ qua backoff; không nối song song khi đang xin vé hoặc Socket.IO đang tự nối", async () => {
    let calls = 0;
    let release: ((t: string) => void) | null = null;
    const { socket, c, wake } = setup(() => {
      calls++;
      if (calls === 1) return Promise.reject(new HubApiError(502, "x"));
      return new Promise<string>((r) => (release = r));
    });
    socket.connect();
    await flush();
    expect(jest.getTimerCount()).toBeGreaterThan(0); // backoff đang chờ
    wake();
    expect(socket.connectCalls).toBe(2); // ngay, không chờ backoff
    wake(); // đang xin vé -> bỏ qua
    wake();
    expect(socket.connectCalls).toBe(2);
    expect(calls).toBe(2);
    (release as unknown as (t: string) => void)("ok");
    await flush();
    c.handleConnect();
    wake(); // đã xanh -> không làm gì
    expect(socket.connectCalls).toBe(2);
  });

  it("đổi project: vé về muộn của lượt cũ bị bỏ (không handshake hộ), nối lại với vé mới", async () => {
    const pending: ((t: string) => void)[] = [];
    const { socket, c, handshakes } = setup(() => new Promise<string>((r) => pending.push(r)));
    socket.connect();
    c.restart();
    expect(socket.connectCalls).toBe(2);
    pending[0]("vé-project-cũ");
    pending[1]("vé-project-mới");
    await flush();
    expect(handshakes).toEqual([{ ticket: "vé-project-mới" }]);
    expect(c.status).toBe("connecting");
  });

  it("unmount/logout (dispose) -> không còn timer, gỡ listener wake, handler sau đó là no-op", async () => {
    const { socket, c, isWakeSubscribed, handshakes, statuses } = setup(() => Promise.reject(new HubApiError(502, "x")));
    socket.connect();
    await flush();
    expect(jest.getTimerCount()).toBeGreaterThan(0); // ngưỡng đỏ + backoff
    expect(isWakeSubscribed()).toBe(true);
    c.dispose();
    expect(jest.getTimerCount()).toBe(0);
    expect(isWakeSubscribed()).toBe(false);
    c.handleDisconnect("io server disconnect");
    c.handleConnectError();
    jest.advanceTimersByTime(10 * REALTIME_RED_AFTER_MS);
    expect(jest.getTimerCount()).toBe(0);
    expect(socket.connectCalls).toBe(1);
    expect(handshakes).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("dispose trong lúc vé còn đang bay -> vé về sau không handshake, không đặt timer", async () => {
    let release: ((t: string) => void) | null = null;
    const { socket, c, handshakes } = setup(() => new Promise<string>((r) => (release = r)));
    socket.connect();
    c.dispose();
    (release as unknown as (t: string) => void)("late");
    await flush();
    expect(handshakes).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
