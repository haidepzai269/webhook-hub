import { PRIVACY_OPTIONS, readWebSentryConfig } from "./config";

describe("readWebSentryConfig", () => {
  it("không DSN (trống / thiếu / khoảng trắng) -> null = no-op", () => {
    expect(readWebSentryConfig({})).toBeNull();
    expect(readWebSentryConfig({ NEXT_PUBLIC_SENTRY_DSN: "   " })).toBeNull();
  });
  it("có DSN: environment mặc định local -> traces 0; deployed -> 0.1; ghi đè hợp lệ được tôn trọng, sai -> mặc định", () => {
    const dsn = "https://k@o1.ingest.de.sentry.io/1";
    expect(readWebSentryConfig({ NEXT_PUBLIC_SENTRY_DSN: dsn })).toMatchObject({ environment: "local", tracesSampleRate: 0 });
    expect(readWebSentryConfig({ NEXT_PUBLIC_SENTRY_DSN: dsn, NEXT_PUBLIC_SENTRY_ENVIRONMENT: "deployed" })?.tracesSampleRate).toBe(0.1);
    expect(readWebSentryConfig({ NEXT_PUBLIC_SENTRY_DSN: dsn, NEXT_PUBLIC_SENTRY_ENVIRONMENT: "deployed", NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "0.25" })?.tracesSampleRate).toBe(0.25);
    for (const bad of ["abc", "2", "-1"]) expect(readWebSentryConfig({ NEXT_PUBLIC_SENTRY_DSN: dsn, NEXT_PUBLIC_SENTRY_ENVIRONMENT: "deployed", NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: bad })?.tracesSampleRate).toBe(0.1);
    expect(readWebSentryConfig({ NEXT_PUBLIC_SENTRY_DSN: dsn, NEXT_PUBLIC_SENTRY_RELEASE: " abc123 " })?.release).toBe("abc123");
  });
  it("quyền riêng tư SDK: không user/cookie/header/body/query", () => {
    expect(PRIVACY_OPTIONS.dataCollection).toEqual({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false });
  });
});
