import { createT, LOCALES, type Locale } from "../i18n/dictionary";
import { insightActions, insightsBySubject, insightText, type InsightView } from "./message";

/** CB6: câu nhận định dựng phía client từ code + facts (SPEC §7) — đủ vi/en, không lọt khoá thô / undefined / NaN. */
const NOW = Date.parse("2026-10-12T14:30:00Z");
const DEST = "3fa2c1d0-0000-4000-8000-000000000001";
const SRC = "5bc2c1d0-0000-4000-8000-000000000002";
const ctx = (locale: Locale) => ({ locale, now: NOW });
const dest = (facts: Record<string, unknown>, level: InsightView["level"] = "ok"): InsightView => ({
  code: "I-dest",
  level,
  subjectType: "destination",
  subjectId: DEST,
  facts,
});
const silent = (facts: Record<string, unknown>, level: InsightView["level"] = "ok"): InsightView => ({
  code: "I-silent",
  level,
  subjectType: "source",
  subjectId: SRC,
  facts,
});

const SAMPLES: InsightView[] = [
  ...["healthy", "auth_rejected", "client_error", "receiver_failing", "circuit_open", "no_deliveries"].map((health) =>
    dest({ health, total: 12, success: 9, retrying: 3, lastStatus: 401, lastAt: "2026-10-12T14:02:00Z" }),
  ),
  ...["normal", "quiet", "learning", "no_events"].map((state) =>
    silent({
      state,
      lastEventAt: state === "no_events" ? null : "2026-10-12T11:30:00Z",
      medianGapMs: 600_000,
      thresholdMs: 21_600_000,
      baseline: 12,
      minBaseline: 20,
    }),
  ),
  {
    code: "I-dup",
    level: "info",
    subjectType: "project",
    subjectId: "p",
    facts: {
      total: 7,
      byProvider: [
        { provider: "payos", n: 5 },
        { provider: "github", n: 2 },
      ],
      since: "2026-10-11T17:00:00Z",
    },
  },
  { code: "I-dup", level: "ok", subjectType: "project", subjectId: "p", facts: { total: 0, byProvider: [] } },
  {
    code: "I-dead",
    level: "warning",
    subjectType: "project",
    subjectId: "p",
    facts: { total: 12, recent: 3, capped: false, windowHours: 24 },
    actions: [{ code: "open_dlq" }],
  },
  {
    code: "I-dead",
    level: "ok",
    subjectType: "project",
    subjectId: "p",
    facts: { total: 0, recent: 0, capped: false },
  },
];

describe("insightText — cả vi lẫn en", () => {
  it.each(LOCALES)("%s: mọi nhận định có nhãn, không lọt khoá thô / undefined / NaN / {biến}", (locale) => {
    const t = createT(locale);
    for (const i of SAMPLES) {
      const x = insightText(i, t, ctx(locale))!;
      expect(x.label.length).toBeGreaterThan(0);
      for (const s of [x.label, x.detail, x.tooltip ?? ""]) {
        expect({ code: i.code, s, bad: /undefined|NaN|\{\w+\}|insights\.|\[object/.test(s) }).toMatchObject({
          bad: false,
        });
      }
    }
  });

  it("I-dest: nhãn đúng năm trạng thái của SPEC + 4xx nội dung, số liệu 1 giờ qua", () => {
    const vi = createT("vi");
    const en = createT("en");
    const label = (health: string, t = vi) =>
      insightText(
        dest({ health, total: 4, success: 1, retrying: 3, lastStatus: 401, lastAt: "2026-10-12T14:02:00Z" }),
        t,
        ctx("vi"),
      )!;
    expect(label("healthy").label).toBe("Khoẻ");
    expect(label("healthy").detail).toBe("1/4 lần giao thành công trong 1 giờ qua.");
    expect(label("auth_rejected").label).toBe("Từ chối xác thực");
    expect(label("auth_rejected").detail).toContain("401");
    expect(label("receiver_failing").label).toBe("Lỗi/chậm phía nhận (đang thử lại)");
    expect(label("receiver_failing").detail).toBe(
      "3/4 lần thử trong 1 giờ qua thất bại; hub vẫn đang tự thử lại giúp bạn.",
    );
    expect(label("circuit_open").label).toBe("Tạm ngưng (cầu dao)");
    expect(label("no_deliveries").label).toBe("Chưa có lượt giao");
    expect(label("auth_rejected", en).label).toBe("Authentication rejected");
    expect(label("receiver_failing", en).label).toBe("Receiver failing/slow (retrying)");
  });

  it("I-silent: 'Sự kiện cuối …' + so với nhịp của chính nguồn", () => {
    const t = createT("vi");
    const q = insightText(
      silent({ state: "quiet", lastEventAt: "2026-10-12T11:30:00Z", medianGapMs: 600_000 }, "warning"),
      t,
      ctx("vi"),
    )!;
    expect(q.label).toBe("Sự kiện cuối 3 giờ trước");
    expect(q.detail).toContain("khoảng 10 phút một sự kiện");
    expect(q.level).toBe("warning");
    const n = insightText(
      silent({ state: "normal", lastEventAt: "2026-10-12T14:25:00Z", medianGapMs: 600_000 }),
      createT("en"),
      ctx("en"),
    )!;
    expect(n).toMatchObject({ label: "Last event 5 min ago", detail: "Normal — about one event every 10 min." });
    expect(
      insightText(
        silent({ state: "learning", lastEventAt: "2026-10-12T14:25:00Z", baseline: 3, minBaseline: 20 }),
        t,
        ctx("vi"),
      )!.detail,
    ).toBe("Chưa đủ 20 sự kiện trong 7 ngày để biết nhịp (mới có 3).");
    expect(insightText(silent({ state: "no_events", lastEventAt: null }), t, ctx("vi"))!.label).toBe(
      "Chưa có sự kiện trong 7 ngày",
    );
  });

  it("I-dup: tổng + tách theo tên hiển thị của provider + tooltip BB-2/BB-3; I-dead: n, k, chạm trần", () => {
    const t = createT("vi");
    const d = insightText(SAMPLES.find((i) => i.code === "I-dup")!, t, ctx("vi"))!;
    expect(d.label).toBe("Hôm nay hub đã chặn 7 sự kiện trùng");
    expect(d.detail).toBe("Theo nhà cung cấp: PayOS 5 · GitHub 2");
    expect(d.tooltip).toContain("PostgreSQL");
    expect(insightText({ ...SAMPLES[SAMPLES.length - 2], facts: { total: 12, recent: 3 } }, t, ctx("vi"))!.label).toBe(
      "12 lượt giao cần xử lý trong hàng đợi lỗi, 3 trong 24 giờ qua",
    );
    // TB1: phần D9 (đích đã lưu trữ) vẫn nằm trong bảng DLQ / KPI -> nói rõ để hai số khớp
    expect(
      insightText(
        { ...SAMPLES[SAMPLES.length - 2], facts: { total: 12, recent: 3, excludedArchived: 4 } },
        t,
        ctx("vi"),
      )!.label,
    ).toBe("12 lượt giao cần xử lý trong hàng đợi lỗi, 3 trong 24 giờ qua (+4 thuộc đích đã lưu trữ)");
    expect(
      insightText(
        { ...SAMPLES[SAMPLES.length - 1], facts: { total: 0, recent: 0, excludedArchived: 2 } },
        createT("en"),
        ctx("en"),
      )!.label,
    ).toBe("No deliveries to handle in the dead-letter queue (+2 for archived destinations)");
    expect(
      insightText(
        { ...SAMPLES[SAMPLES.length - 2], facts: { total: 10000, recent: 50, capped: true } },
        createT("en"),
        ctx("en"),
      )!.label,
    ).toBe("At least 10000 deliveries to handle in the dead-letter queue, 50 in the last 24 hours");
    expect(insightText(SAMPLES[SAMPLES.length - 1], t, ctx("vi"))!.label).toBe(
      "Không có lượt giao nào cần xử lý trong hàng đợi lỗi",
    );
  });

  it("hành động -> link có bộ lọc, id lạ không ghép vào URL; mã nhận định lạ -> null", () => {
    expect(
      insightActions({
        ...dest({ health: "auth_rejected" }),
        actions: [
          { code: "view_deliveries", params: { destinationId: DEST } },
          { code: "open_dlq", params: { destinationId: DEST } },
        ],
      }).map((a) => a.href),
    ).toEqual([`/dashboard/deliveries?destination=${DEST}`, `/dashboard/dlq?destination=${DEST}`]);
    expect(
      insightActions({
        ...silent({}),
        actions: [{ code: "view_events", params: { sourceId: "x' or 1" } }, { code: "nope" }],
      }).map((a) => a.href),
    ).toEqual(["/dashboard/events"]);
    expect(insightActions(SAMPLES.find((i) => i.code === "I-dead")!)[0]).toEqual({
      labelKey: "alerts.action.open-dlq",
      href: "/dashboard/dlq",
    });
    expect(insightText({ ...SAMPLES[0], code: "I-latency" as never }, createT("vi"), ctx("vi"))).toBeNull();
    expect([...insightsBySubject(SAMPLES, "I-silent").keys()]).toEqual([SRC]);
  });
});
