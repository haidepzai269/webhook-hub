import { translate } from "../i18n/dictionary";
import { blockedNowText, trafficInsightText } from "./message";

const tv = (locale: "vi" | "en") => (k: any, v?: any) => translate(locale, k, v);

describe("EG5 câu nhận định lưu lượng (web)", () => {
  it("ví dụ của spec, hai ngôn ngữ", () => {
    const i = {
      code: "I-traffic" as const,
      level: "warning" as const,
      facts: {
        range: "1h",
        state: "attention",
        total: 1240,
        rejectedPct: 31,
        rateLimited: 0,
        blocked: 0,
        dominantIp: "203.0.113.7",
      },
    };
    expect(trafficInsightText(i, tv("vi"), "vi", "1h")?.label).toBe(
      "1 giờ qua: 1.240 request · 31% sai chữ ký · phần lớn từ 1 IP (203.0.113.7)",
    );
    expect(trafficInsightText(i, tv("en"), "en", "1h")?.label).toBe(
      "Last hour: 1,240 requests · 31% bad signature · mostly from 1 IP (203.0.113.7)",
    );
    expect(trafficInsightText(i, tv("vi"), "vi", "1h")?.level).toBe("warning");
  });

  it("trạng thái trống thân thiện; mã lạ -> null; dòng tạm chặn", () => {
    const empty = {
      code: "I-traffic" as const,
      level: "ok" as const,
      facts: { range: "24h", state: "empty", total: 0 },
    };
    expect(trafficInsightText(empty, tv("vi"), "vi", "1h")).toMatchObject({
      empty: true,
      label: "Chưa có request nào trong 24 giờ qua",
    });
    expect(trafficInsightText(empty, tv("en"), "en", "1h")?.label).toBe("No requests in the last 24 hours");
    expect(trafficInsightText({ code: "I-other" } as any, tv("vi"), "vi", "1h")).toBeNull();
    expect(blockedNowText([], tv("vi"))).toBeNull();
    expect(blockedNowText([{ ip: "1.1.1.1", remainingSec: 401 }], tv("vi"))).toBe(
      "Hub đang tạm chặn 1 IP gửi sai chữ ký vào nguồn này (còn 7 phút).",
    );
  });
});
