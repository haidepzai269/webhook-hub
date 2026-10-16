import { type BootPhase, bootFailureAction, loadSession, runBoot, SLOW_NOTICE_MS } from "./auth-boot";
import { holdAuthGate, isAuthGateClosed, openAuthGate, releaseAuthGate, resetAuthGateForTest } from "./auth-gate";
import { HUB_FETCH_TIMEOUT_MS, HubApiError, HubTimeoutError, hubFetch } from "./client";
import { useProjectStore } from "./project-store";

/**
 * ADR-238 — trang trắng 10–60s khi hub-api (Render free) cold start: AuthGuard trả `null` trong lúc chờ `/auth/me` rồi
 * `/api/v1/projects` TUẦN TỰ, hubFetch không có timeout. Sau sửa: khung app + khung chờ render ngay, nhưng dữ liệu bảo vệ
 * vẫn không thể về trước khi phiên xác nhận (cổng hubFetch); hai request song song; quá hạn -> "Thử lại", không treo.
 */

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: (url: string, init: RequestInit) => Promise<Response>;

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  calls = [];
  respond = () => json(200, {});
  (globalThis as { fetch: unknown }).fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  resetAuthGateForTest();
  useProjectStore.setState({ userId: null, projectId: null });
});
afterEach(async () => {
  jest.useRealTimers();
  resetAuthGateForTest();
  await new Promise((r) => setTimeout(r, 5)); // single-flight refresh của test trước nhả hẳn
});

describe("cổng auth của hubFetch — không dữ liệu bảo vệ nào đi/về trước khi AuthGuard xác nhận", () => {
  it("guard đang chờ: /api/v1/* bị giữ (chưa gửi), /auth/* và request của chính guard đi ngay", async () => {
    holdAuthGate();
    const events = hubFetch("/api/v1/events");
    void hubFetch("/auth/me");
    void hubFetch("/api/v1/projects", { bypassAuthGate: true });
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["/auth/me", "/api/v1/projects"]);

    // Guard chọn project rồi mở cổng: request đang chờ đi với ĐÚNG project (gắn lúc đi, không phải lúc gọi).
    useProjectStore.setState({ projectId: "P1" });
    openAuthGate();
    await events;
    expect(calls.map((c) => c.url)).toContain("/api/v1/events?projectId=P1");
  });

  it("không có guard (trang login/invite) thì cổng mở — không request nào bị kẹt", async () => {
    await hubFetch("/api/v1/events");
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/events"]);
  });

  it("StrictMode / đổi layout (gỡ rồi gắn lại ngay) không mở cổng giữa chừng; gỡ hẳn thì nhả sau một nhịp", async () => {
    jest.useFakeTimers();
    holdAuthGate();
    releaseAuthGate();
    holdAuthGate(); // gắn lại trong cùng commit
    await jest.advanceTimersByTimeAsync(1);
    expect(isAuthGateClosed()).toBe(true);
    releaseAuthGate();
    await jest.advanceTimersByTimeAsync(1);
    expect(isAuthGateClosed()).toBe(false);
  });
});

describe("loadSession — /auth/me và /api/v1/projects song song", () => {
  it("cả hai request đã gửi trước khi cái nào trả lời; project đi qua cổng", async () => {
    const pending: Record<string, (v: unknown) => void> = {};
    const seen: { path: string; init?: { bypassAuthGate?: boolean } }[] = [];
    const fetcher = (<T>(path: string, init?: { bypassAuthGate?: boolean }) => {
      seen.push({ path, init });
      return new Promise<T>((resolve) => (pending[path] = resolve as (v: unknown) => void));
    }) as Parameters<typeof loadSession>[0];
    const p = loadSession(fetcher);
    await flush();
    expect(seen.map((s) => s.path)).toEqual(["/auth/me", "/api/v1/projects"]);
    expect(seen[1].init?.bypassAuthGate).toBe(true);
    pending["/api/v1/projects"]([{ id: "P1" }]);
    pending["/auth/me"]({ user: { id: "u1" }, memberships: [] });
    await expect(p).resolves.toEqual({ me: { user: { id: "u1" }, memberships: [] }, projects: [{ id: "P1" }] });
  });
});

describe("runBoot — pending -> slow -> ok | failed | login", () => {
  const session = {
    me: { user: { id: "u1", email: "", name: "", emailVerified: true }, memberships: [] },
    projects: [],
  };

  it("ok: báo 'slow' sau 5s; onReady chạy khi cổng CÒN đóng (chọn project trước), xong mới mở cổng", async () => {
    jest.useFakeTimers();
    holdAuthGate();
    const phases: BootPhase[] = [];
    let gateClosedInReady: boolean | null = null;
    let finish!: (s: typeof session) => void;
    runBoot(
      {
        onPhase: (p) => phases.push(p),
        onReady: () => (gateClosedInReady = isAuthGateClosed()),
        onLogin: () => phases.push("login" as BootPhase),
      },
      () => new Promise((r) => (finish = r)),
    );
    expect(phases).toEqual(["pending"]);
    await jest.advanceTimersByTimeAsync(SLOW_NOTICE_MS);
    expect(phases).toEqual(["pending", "slow"]);
    expect(isAuthGateClosed()).toBe(true);
    finish(session);
    await jest.advanceTimersByTimeAsync(0);
    expect(gateClosedInReady).toBe(true);
    expect(phases).toEqual(["pending", "slow", "ok"]);
    expect(isAuthGateClosed()).toBe(false);
  });

  it.each([
    ["timeout (server đang thức)", "failed", new HubTimeoutError(HUB_FETCH_TIMEOUT_MS)],
    ["mạng/proxy chết", "failed", new TypeError("Failed to fetch")],
    ["502 của proxy lúc Render khởi động", "failed", new HubApiError(502, "Bad Gateway")],
    ["401 sau refresh", "login", new HubApiError(401, "session")],
    ["403", "login", new HubApiError(403, "forbidden")],
  ])("%s -> %s; cổng vẫn đóng (trang giữ khung chờ, không dữ liệu)", async (_name, expected, err) => {
    holdAuthGate();
    const phases: string[] = [];
    runBoot(
      { onPhase: (p) => phases.push(p), onReady: () => phases.push("ready"), onLogin: () => phases.push("login") },
      () => Promise.reject(err),
    );
    await flush();
    expect(phases).toEqual(["pending", expected]);
    expect(bootFailureAction(err)).toBe(expected === "failed" ? "retry" : "login");
    expect(isAuthGateClosed()).toBe(true);
  });

  it("huỷ (effect cleanup / bấm Thử lại) -> lượt cũ không gọi callback nữa", async () => {
    const phases: string[] = [];
    let finish!: (s: typeof session) => void;
    const cancel = runBoot(
      { onPhase: (p) => phases.push(p), onReady: () => phases.push("ready"), onLogin: () => phases.push("login") },
      () => new Promise((r) => (finish = r)),
    );
    cancel();
    finish(session);
    await flush();
    expect(phases).toEqual(["pending"]);
  });
});

describe("hubFetch — timeout, không treo vô hạn", () => {
  it(`quá ${HUB_FETCH_TIMEOUT_MS / 1000}s -> HubTimeoutError (status 0), request bị huỷ`, async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    respond = (_url, init) =>
      new Promise((_, reject) => {
        signal = init.signal ?? undefined;
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const p = hubFetch("/auth/me");
    const settled = p.then(
      () => "resolved",
      (e: unknown) => e,
    );
    await jest.advanceTimersByTimeAsync(HUB_FETCH_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(HubTimeoutError);
    expect((err as HubTimeoutError).status).toBe(0);
    expect(signal?.aborted).toBe(true);
  });

  it("timeoutMs riêng được tôn trọng; signal của caller huỷ thì là lỗi abort, không phải timeout", async () => {
    jest.useFakeTimers();
    respond = (_url, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    const short = hubFetch("/auth/me", { timeoutMs: 1_000 }).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await short).toBeInstanceOf(HubTimeoutError);

    const ctrl = new AbortController();
    const aborted = hubFetch("/auth/me", { signal: ctrl.signal }).catch((e: unknown) => e);
    ctrl.abort();
    const err = await aborted;
    expect(err).not.toBeInstanceOf(HubTimeoutError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("không đưa tuỳ chọn riêng (timeoutMs, bypassAuthGate) xuống fetch", async () => {
    await hubFetch("/api/v1/projects", { timeoutMs: 5_000, bypassAuthGate: true });
    expect(calls[0].init).not.toHaveProperty("timeoutMs");
    expect(calls[0].init).not.toHaveProperty("bypassAuthGate");
    expect(calls[0].init.credentials).toBe("include");
  });
});

describe("refresh khi hai request song song cùng gặp 401 — đúng MỘT lần /auth/refresh", () => {
  const refreshCount = () => calls.filter((c) => c.url === "/auth/refresh").length;

  it("hai 401 cùng lúc -> single-flight, cả hai thử lại thành công", async () => {
    let refreshed = false;
    respond = (url) => {
      if (url === "/auth/refresh") {
        refreshed = true;
        return json(200, {});
      }
      return refreshed ? json(200, { url }) : json(401, { error: "unauthorized" });
    };
    const [a, b] = await Promise.all([hubFetch("/auth/me"), hubFetch("/api/v1/projects", { bypassAuthGate: true })]);
    expect(a).toEqual({ url: "/auth/me" });
    expect(b).toEqual({ url: "/api/v1/projects" });
    expect(refreshCount()).toBe(1);
  });

  it("401 về SAU khi refresh của request kia đã xong (single-flight đã nhả) -> thử lại thẳng, không refresh lần hai", async () => {
    let refreshed = false;
    let releaseLate!: () => void;
    const late = new Promise<void>((r) => (releaseLate = r));
    respond = (url) => {
      if (url === "/auth/refresh") {
        refreshed = true;
        return json(200, {});
      }
      if (url === "/api/v1/projects" && !refreshed) return late.then(() => json(401, { error: "unauthorized" }));
      return refreshed ? json(200, { url }) : json(401, { error: "unauthorized" });
    };
    const projects = hubFetch("/api/v1/projects", { bypassAuthGate: true }); // gửi bằng cookie cũ, 401 về muộn
    await expect(hubFetch("/auth/me")).resolves.toEqual({ url: "/auth/me" });
    await new Promise((r) => setTimeout(r, 5)); // single-flight đã nhả
    releaseLate();
    await expect(projects).resolves.toEqual({ url: "/api/v1/projects" });
    expect(refreshCount()).toBe(1);
  });
});
