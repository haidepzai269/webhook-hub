import { classifyFrontendCause, isExpectedApiError, scrubBreadcrumb, scrubText, scrubUrl, scrubWebEvent } from "./scrub";

/** LOGGING.md §11.9e "test không-lọt": bắn các mẫu secret/PII vào MỌI chỗ của event, khẳng định không còn trong JSON gửi đi. */
const SECRETS = [
  "whsec_MfKQ9r8GKYqrTwjBfAbcdEFGH12345",
  "hk_live_ABCDEFGHIJKLMNOP12345678",
  "hk_test_zyxwvutsrqponm98765432",
  "Bearer abcdefghijklmnop.qrstuvwxyz0123",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  "sk_live_51HxxxxxxxxxxABCDEF",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "__Host-hub_at=SESSIONTOKENVALUE123",
  "hub_csrf=CSRFVALUE12345",
  "nguyen.van.a@example.com",
  "s3cr3tPassw0rd!",
  "postgres-pass-9999",
];

function leaks(obj: unknown): string[] {
  const json = JSON.stringify(obj);
  return SECRETS.filter((s) => json.includes(s) || json.includes(s.replace(/^(Bearer |__Host-hub_at=|hub_csrf=)/, "")));
}

function dirtyEvent() {
  return {
    message: `thất bại với whsec_MfKQ9r8GKYqrTwjBfAbcdEFGH12345 cho nguyen.van.a@example.com`,
    exception: {
      values: [
        {
          type: "Error",
          value: "Authorization: Bearer abcdefghijklmnop.qrstuvwxyz0123 hk_live_ABCDEFGHIJKLMNOP12345678 password=s3cr3tPassw0rd! tại https://user:postgres-pass-9999@api.example.com/x?token=hk_test_zyxwvutsrqponm98765432#frag",
          stacktrace: { frames: [{ filename: "https://hub.example.com/_next/static/a.js?sig=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", lineno: 1 }] },
        },
      ],
    },
    request: {
      url: "https://hub.example.com/invite?token=hk_live_ABCDEFGHIJKLMNOP12345678#sk_live_51HxxxxxxxxxxABCDEF",
      method: "POST",
      data: { password: "s3cr3tPassw0rd!" },
      cookies: { hub_csrf: "CSRFVALUE12345" },
      headers: { cookie: "__Host-hub_at=SESSIONTOKENVALUE123; hub_csrf=CSRFVALUE12345", authorization: "Bearer abcdefghijklmnop.qrstuvwxyz0123" },
      query_string: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    },
    user: { email: "nguyen.van.a@example.com", ip_address: "1.2.3.4" },
    extra: { body: "s3cr3tPassw0rd!" },
    server_name: "nguyen.van.a@example.com",
    breadcrumbs: [
      { category: "console", message: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      { category: "fetch", data: { url: "/api/x?key=hk_live_ABCDEFGHIJKLMNOP12345678", body: "s3cr3tPassw0rd!" } },
      { category: "ui.input", message: "nguyen.van.a@example.com" },
      { category: "navigation", timestamp: 1, data: { from: "/login?email=nguyen.van.a@example.com", to: "/dashboard?token=hk_live_ABCDEFGHIJKLMNOP12345678#x" } },
    ],
    tags: { svc: "web", password: "s3cr3tPassw0rd!", email: "nguyen.van.a@example.com", request_id: "evil whsec_MfKQ9r8GKYqrTwjBfAbcdEFGH12345" },
    contexts: { trace: { trace_id: "a".repeat(32) }, device: { name: "nguyen.van.a@example.com" }, state: { password: "s3cr3tPassw0rd!" } },
    transaction: "/dashboard/events?token=hk_live_ABCDEFGHIJKLMNOP12345678",
  };
}

describe("scrubWebEvent: test không-lọt (§11.9e)", () => {
  it("event bẩn -> JSON gửi đi không còn mẫu secret/email nào", () => {
    const out = scrubWebEvent(dirtyEvent(), new Error("x"));
    expect(out).not.toBeNull();
    expect(leaks(out)).toEqual([]);
  });

  it("bỏ user/extra/server_name/cookie/header/body/query_string; request chỉ còn method + url sạch", () => {
    const out = scrubWebEvent(dirtyEvent(), new Error("x"));
    expect(out.user).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(out.request).toEqual({ url: "https://hub.example.com/invite", method: "POST" });
  });

  it("breadcrumb: chỉ giữ navigation, đã bỏ query/hash; console/fetch/ui.* bị bỏ", () => {
    const out = scrubWebEvent(dirtyEvent(), new Error("x"));
    expect(out.breadcrumbs).toEqual([{ category: "navigation", timestamp: 1, data: { from: "/login", to: "/dashboard" } }]);
  });

  it("tag theo allowlist; request_id sai định dạng bị bỏ; context chỉ trace/browser/os/culture", () => {
    const out = scrubWebEvent(dirtyEvent(), new Error("x"));
    expect(Object.keys(out.tags).sort()).toEqual(["frontend_cause", "svc"]);
    expect(Object.keys(out.contexts)).toEqual(["trace"]);
    expect(out.transaction).toBe("/dashboard/events");
  });

  it("transaction (web vitals): span http bỏ query, khoá nhạy cảm bị che, measurements còn nguyên", () => {
    const tx = {
      type: "transaction",
      transaction: "/dashboard?token=hk_live_ABCDEFGHIJKLMNOP12345678",
      measurements: { lcp: { value: 1200, unit: "millisecond" } },
      spans: [
        { op: "http.client", description: "GET /api/v1/events?key=hk_live_ABCDEFGHIJKLMNOP12345678", data: { "http.query": "?key=hk_live_ABCDEFGHIJKLMNOP12345678", "url.full": "https://u:postgres-pass-9999@h.com/a?b=1" } },
      ],
    };
    const out = scrubWebEvent(tx);
    expect(leaks(out)).toEqual([]);
    expect(out.measurements.lcp.value).toBe(1200);
    expect(out.spans[0].description).toBe("GET /api/v1/events");
    expect(out.spans[0].data["url.full"]).toBe("https://h.com/a");
  });

  it("lỗi 4xx của hub là có chủ đích -> bỏ event; 5xx và lỗi khác -> gửi", () => {
    const e4 = Object.assign(new Error("nope"), { name: "HubApiError", status: 404 });
    const e5 = Object.assign(new Error("boom"), { name: "HubApiError", status: 502, requestId: "req_abc-123", cold: true });
    expect(isExpectedApiError(e4)).toBe(true);
    expect(scrubWebEvent({ exception: { values: [{ type: "HubApiError", value: "nope" }] } }, e4)).toBeNull();
    const out = scrubWebEvent({ exception: { values: [{ type: "HubApiError", value: "boom" }] } }, e5);
    expect(out.tags).toMatchObject({ svc: "web", request_id: "req_abc-123", cold: "1", frontend_cause: "cold_start" });
  });

  it("nhiễu vô hại (ResizeObserver, NEXT_REDIRECT) bị bỏ; event rác (null/chuỗi) -> null", () => {
    expect(scrubWebEvent({ exception: { values: [{ type: "Error", value: "ResizeObserver loop completed with undelivered notifications." }] } })).toBeNull();
    expect(scrubWebEvent({ exception: { values: [{ type: "Error", value: "NEXT_REDIRECT" }] } })).toBeNull();
    expect(scrubWebEvent(null)).toBeNull();
    expect(scrubWebEvent("x")).toBeNull();
  });

  it("request_id có chứa secret thì bị BỎ, không 'làm sạch'", () => {
    const e = Object.assign(new Error("boom"), { name: "HubApiError", status: 500, requestId: "bad id whsec_MfKQ9r8GKYqrTwjBfAbcdEFGH12345" });
    const out = scrubWebEvent({ exception: { values: [{ type: "HubApiError", value: "boom" }] } }, e);
    expect(out.tags.request_id).toBeUndefined();
  });
});

describe("scrubUrl / scrubText / scrubBreadcrumb", () => {
  it("URL: bỏ userinfo, query, hash; giữ path; URL tương đối cũng vậy", () => {
    expect(scrubUrl("https://u:p@h.com:8080/a/b?x=1#y")).toBe("https://h.com:8080/a/b");
    expect(scrubUrl("/reset-password?token=abc#x")).toBe("/reset-password");
    expect(scrubUrl("/ok")).toBe("/ok");
  });
  it("text tự do: URL trong câu bị cắt query, connection string bị che userinfo", () => {
    expect(scrubText("lỗi tại https://a.com/p?token=zzzzzzzz sau đó")).toBe("lỗi tại https://a.com/p sau đó");
    expect(scrubText("postgres://admin:pw123@db.host:5432/x")).toBe("postgres://***@db.host:5432/x");
  });
  it("breadcrumb không phải navigation -> null", () => {
    for (const category of ["console", "fetch", "xhr", "ui.click", "ui.input", "sentry.event"]) expect(scrubBreadcrumb({ category })).toBeNull();
    expect(scrubBreadcrumb(null)).toBeNull();
  });
});

describe("classifyFrontendCause (enum đóng)", () => {
  it("phân loại", () => {
    expect(classifyFrontendCause(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe("chunk_load");
    expect(classifyFrontendCause(new Error("Failed to fetch dynamically imported module: /_next/a.js"))).toBe("chunk_load");
    expect(classifyFrontendCause(Object.assign(new Error("t"), { name: "HubTimeoutError", status: 0 }))).toBe("slow_api");
    expect(classifyFrontendCause(new TypeError("Failed to fetch"))).toBe("network_or_cors");
    expect(classifyFrontendCause(new Error("undefined is not a function"))).toBe("js_exception");
    expect(classifyFrontendCause("lỗi chuỗi")).toBe("js_exception");
    expect(classifyFrontendCause(undefined)).toBe("js_exception");
  });
});
