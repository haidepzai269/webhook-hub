import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** §11.9e + ADR-264: một cửa vào SDK; Replay tắt; không cấu hình bỏ che; DSN trống = không nạp SDK. */
const SRC = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.spec\.ts$/.test(n) ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split(sep).join("/"), text: readFileSync(p, "utf8") }));

describe("Sentry web: một cửa, Replay tắt", () => {
  it("chỉ lib/sentry/init.client.ts import @sentry/nextjs và gọi captureException", () => {
    const importers = files.filter((f) => /from\s+["']@sentry\//.test(f.text) || /import\(["']@sentry\//.test(f.text)).map((f) => f.rel);
    expect(importers).toEqual(["lib/sentry/init.client.ts"]);
    const capturers = files.filter((f) => /\bcaptureException\s*\(/.test(f.text)).map((f) => f.rel);
    expect(capturers).toEqual(["lib/sentry/init.client.ts"]);
  });
  it("không có replayIntegration / replaysSessionSampleRate / replaysOnErrorSampleRate / maskAllText:false / blockAllMedia:false / tunnelRoute", () => {
    const code = files.map((f) => f.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");
    expect(code).not.toMatch(/replayIntegration|replaysSessionSampleRate|replaysOnErrorSampleRate|maskAllText\s*:\s*false|blockAllMedia\s*:\s*false|maskAllInputs\s*:\s*false|tunnelRoute/);
  });
  it("mọi chỗ nạp SDK nằm sau điều kiện NEXT_PUBLIC_SENTRY_DSN (instrumentation-client, report)", () => {
    for (const rel of ["instrumentation-client.ts", "lib/sentry/report.ts"]) {
      const text = files.find((f) => f.rel === rel)?.text ?? "";
      expect(text).toMatch(/if\s*\(\s*!?process\.env\.NEXT_PUBLIC_SENTRY_DSN\s*\)/);
      expect(text).not.toMatch(/^import .* from ["']@sentry/m);
    }
  });
});
