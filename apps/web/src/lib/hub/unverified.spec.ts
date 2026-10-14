import * as fs from "fs";
import * as path from "path";

import { connectionState, LISTEN_REASON_KEYS, listenReasonKey, type InspectRow } from "./listen-logic";
import { isUnverified, isUnverifiedSource, journeyUnverified, SIGNATURE_VIEW, signatureView, unverifiedSourceBlocked } from "./unverified";
import { DICTIONARIES } from "../i18n/dictionary";

/**
 * PK5 khoá 2 (SPEC-provider-khac §7.1 "Console hiện nhãn Chưa xác thực ở mọi nơi có event", ADR-206) — REVIEW-PK5 TB-1 và T-9.
 * Logic thuần + gác tĩnh: mỗi màn hiện sự kiện phải vẽ `<UnverifiedBadge` (gỡ ở một màn -> đỏ).
 */
const WEB = path.join(__dirname, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(WEB, p), "utf8");
const row = (id: string, status: string, diagnosis: InspectRow["diagnosis"]): InspectRow => ({ id, status, receivedAt: "2026-10-14T00:00:00Z", diagnosis });

describe("PK5 — nhãn \"Chưa xác thực\" ở console (REVIEW-PK5 TB-1)", () => {
  it("[PK:T16] (phần m) isUnverified / journeyUnverified chỉ đúng khi server nói rõ verified=false (vắng = đã xác thực)", () => {
    expect(isUnverified({ verified: false })).toBe(true);
    expect([isUnverified({ verified: true }), isUnverified({}), isUnverified(null), isUnverified(undefined)]).toEqual([false, false, false, false]);
    expect(journeyUnverified({ event: { verified: true }, raw: { verified: false } })).toBe(true);
    expect(journeyUnverified({ event: { verified: false }, raw: null })).toBe(true);
    expect(journeyUnverified({ event: {}, raw: {} })).toBe(false);
  });

  it("[PK:T16] (phần n) Lắng nghe: ACCEPTED của nguồn unverified -> câu riêng, KHÔNG phải \"hợp lệ\"; trạng thái kết nối đánh dấu unverified", () => {
    expect(listenReasonKey("unverified")).toBe("page.sources.listen.reason.unverified");
    expect(listenReasonKey("unverified")).not.toBe(LISTEN_REASON_KEYS.ok);
    expect(listenReasonKey("lạ")).toBe("page.sources.listen.reason.unknown");
    for (const locale of ["vi", "en"] as const) {
      const text = (DICTIONARIES[locale] as Record<string, string>)["page.sources.listen.reason.unverified"];
      expect(text).not.toBe((DICTIONARIES[locale] as Record<string, string>)["page.sources.listen.reason.ok"]);
    }
    expect(DICTIONARIES.vi["page.sources.listen.reason.unverified"]).toMatch(/chưa xác thực/);
    expect(DICTIONARIES.vi["page.sources.listen.connected-unverified"]).not.toContain("✓");
    const st = connectionState([row("a", "ACCEPTED", { ok: true, reason: "unverified" })]);
    expect(st).toMatchObject({ kind: "connected", unverified: true });
    expect(connectionState([row("a", "ACCEPTED", { ok: true, reason: "ok" })])).toMatchObject({ kind: "connected", unverified: false });
  });

  it("[PK:T16] (phần o) gác tĩnh: mọi màn hiện sự kiện vẽ <UnverifiedBadge>; trang chi tiết dùng journeyUnverified; Lắng nghe dùng listenReasonKey + connected-unverified", () => {
    const screens = [
      "src/app/(admin)/dashboard/events/page.tsx", // danh sách hành trình
      "src/app/(admin)/dashboard/events/[id]/page.tsx", // chi tiết / hành trình
      "src/app/(admin)/dashboard/events/_components/event-columns.tsx", // bảng sự kiện (Tổng quan)
      "src/app/(admin)/dashboard/events/_components/event-sheet.tsx", // xem nhanh
      "src/app/(admin)/dashboard/deliveries/_components/delivery-columns.tsx", // lượt giao + DLQ (dùng chung cột)
      "src/components/flow/event-log.tsx", // nhật ký sự kiện ở trang Luồng (REVIEW-PK5-R2 T-a)
    ];
    for (const f of screens) expect([f, /<UnverifiedBadge\b/.test(read(f))]).toEqual([f, true]);
    expect(read("src/app/(admin)/dashboard/events/[id]/page.tsx")).toMatch(/journeyUnverified\(data\)/);
    const listen = read("src/app/(admin)/dashboard/sources/listen-sheet.tsx");
    expect(listen).toMatch(/listenReasonKey\(/);
    expect(listen).toMatch(/state\.unverified/);
    expect(listen).toMatch(/page\.sources\.listen\.connected-unverified/);
    // Badge màu cảnh báo, không xanh.
    const badge = read("src/components/flow/unverified-badge.tsx");
    expect(badge).toMatch(/amber/);
    expect(badge).not.toMatch(/emerald|green/);
  });
});

describe("PK5 — xem nhanh không bao giờ ghi \"Chữ ký hợp lệ\" cho sự kiện chưa xác thực (REVIEW-PK5-R2 TB-1b)", () => {
  const raw = (signatureValid: boolean, verified?: boolean) => ({ signatureValid, ...(verified === undefined ? {} : { verified }) });

  it("[PK:T16] (phần p) signatureView: event HOẶC raw verified=false -> unverified (dù raw.signatureValid=true); còn lại theo signatureValid", () => {
    // Nguồn unverified ghi raw_events.signature_valid = true (ingest.service, cố ý) — không được hiện "hợp lệ".
    expect(signatureView({ verified: false, rawEvent: raw(true) })).toBe("unverified");
    expect(signatureView({ verified: true, rawEvent: raw(true, false) })).toBe("unverified");
    expect(signatureView({ rawEvent: raw(true, false) })).toBe("unverified");
    expect(signatureView({ verified: true, rawEvent: raw(true) })).toBe("valid");
    expect(signatureView({ rawEvent: raw(true) })).toBe("valid"); // vắng = đã xác thực (dữ liệu trước PK5)
    expect(signatureView({ verified: true, rawEvent: raw(false) })).toBe("invalid");
    // Nhãn + tông: unverified = hổ phách "Chưa xác thực", không bao giờ khoá "hợp lệ" / tông ok.
    expect(SIGNATURE_VIEW.unverified).toMatchObject({ key: "page.events.unverified", tone: "warn" });
    expect(SIGNATURE_VIEW.unverified.key).not.toBe(SIGNATURE_VIEW.valid.key);
    expect(SIGNATURE_VIEW.unverified.className).toMatch(/amber/);
    expect(SIGNATURE_VIEW.unverified.className).not.toMatch(/emerald|green/);
    expect(SIGNATURE_VIEW.valid).toMatchObject({ key: "page.events.sheet.signature-valid", tone: "ok" });
    expect(SIGNATURE_VIEW.invalid).toMatchObject({ key: "page.events.sheet.signature-invalid", tone: "bad" });
  });

  it("[PK:T16] (phần q) gác tĩnh: file nào hiện khoá signature-valid / đọc .signatureValid phải đi qua isUnverified; xem nhanh + bước ① dùng signatureView", () => {
    const SRC = path.join(WEB, "src");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) return walk(p);
        return /\.(ts|tsx)$/.test(d.name) && !/\.spec\.tsx?$/.test(d.name) ? [p] : [];
      });
    const offenders: string[] = [];
    let seen = 0;
    for (const f of walk(SRC)) {
      const rel = path.relative(WEB, f).split(path.sep).join("/");
      if (rel.startsWith("src/lib/i18n/messages/") || rel === "src/lib/hub/types.ts") continue; // định nghĩa chữ / kiểu, không hiện
      const text = fs.readFileSync(f, "utf8");
      if (!/page\.events\.sheet\.signature-valid|\.signatureValid\b/.test(text)) continue;
      seen++;
      if (!/\bisUnverified\(/.test(text)) offenders.push(rel);
    }
    expect(seen).toBeGreaterThan(0); // luật còn bắt được ai (không xanh rỗng)
    expect(offenders).toEqual([]);
    for (const f of ["src/app/(admin)/dashboard/events/_components/event-sheet.tsx", "src/app/(admin)/dashboard/events/_components/trace-timeline.tsx"]) {
      const text = read(f);
      expect([f, /signatureView\(/.test(text), /SIGNATURE_VIEW\[/.test(text)]).toEqual([f, true, true]);
      // Không còn tự quyết "hợp lệ" / tông xanh theo riêng signatureValid.
      expect([f, /signatureValid\s*\?/.test(text)]).toEqual([f, false]);
    }
  });
});

describe("PK5 — cảnh báo cạnh nguồn unverified khi project tắt cờ (REVIEW-PK5 T-9)", () => {
  const unv = { provider: "generic", verificationConfig: { scheme: "unverified", eventType: "momo.ipn" } };
  it("[PK:T14] (phần j) chỉ cảnh báo khi nguồn unverified VÀ cờ được biết là tắt", () => {
    expect(isUnverifiedSource(unv)).toBe(true);
    expect(unverifiedSourceBlocked(unv, false)).toBe(true);
    expect(unverifiedSourceBlocked(unv, true)).toBe(false);
    expect(unverifiedSourceBlocked(unv, undefined)).toBe(false); // đang tải / không đọc được -> không cảnh báo bừa
    expect(unverifiedSourceBlocked({ provider: "generic", verificationConfig: { scheme: "hmac" } }, false)).toBe(false);
    expect(unverifiedSourceBlocked({ provider: "payos", verificationConfig: null }, false)).toBe(false);
    expect(read("src/app/(admin)/dashboard/sources/page.tsx")).toMatch(/<UnverifiedBlockedNote\b/);
    expect(DICTIONARIES.vi["page.sources.unverified-blocked"]).toMatch(/Nhận nguồn chưa xác thực/);
    // REVIEW-PK5-R2 T-d: hệ quả T-1 — bắt tay cũng bị từ chối, bật cờ rồi phải đăng ký lại URL ở nhà cung cấp.
    expect(DICTIONARIES.vi["page.sources.unverified-blocked"]).toMatch(/kể cả request bắt tay — bật cờ rồi đăng ký lại URL ở nhà cung cấp/);
    expect(DICTIONARIES.en["page.sources.unverified-blocked"]).toMatch(/including handshake requests — turn it on, then re-register the URL with the provider/);
  });

  it("[PK:T36] (phần h) REVIEW-PK5-R2 T-e: lý do bỏ qua replay event_trimmed có nhãn vi/en (không rơi về mã thô)", () => {
    expect(read("src/app/(admin)/dashboard/dlq/page.tsx")).toMatch(/event_trimmed:\s*"page\.dlq\.skip\.event-trimmed"/);
    expect(DICTIONARIES.vi["page.dlq.skip.event-trimmed"]).toMatch(/dọn/);
    expect(DICTIONARIES.en["page.dlq.skip.event-trimmed"]).toMatch(/trimmed/);
  });
});
