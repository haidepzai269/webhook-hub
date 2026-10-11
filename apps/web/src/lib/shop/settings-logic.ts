// SK3: logic THUẦN của trang Cài đặt kết nối (không React, không env) để test được.

export interface SettingsForm {
  hubConnectionUrl: string;
  paymentSourceKeys: string[];
  payosClientId: string;
  payosApiKey: string;
  payosChecksumKey: string;
  bankCode: string;
  bankAccount: string;
  bankAccountName: string;
}

export const emptyForm = (): SettingsForm => ({
  hubConnectionUrl: "",
  paymentSourceKeys: [],
  payosClientId: "",
  payosApiKey: "",
  payosChecksumKey: "",
  bankCode: "",
  bankAccount: "",
  bankAccountName: "",
});

/** Body PUT: chỉ gửi ô có chữ (ô trống = giữ nguyên giá trị đang lưu — SPEC §4.3). */
export function buildSettingsBody(f: SettingsForm): Record<string, string | string[]> {
  const body: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v)) {
      if (v.length) body[k] = v;
    } else if (v.trim()) body[k] = v.trim();
  }
  return body;
}

/** Gợi ý tick sẵn: source thanh toán (payos/sepay) đang bật; nếu đã lưu nguồn thì giữ đúng lựa chọn đó. */
export function suggestSourceKeys(
  sources: { sourceKey: string; provider: string; isActive: boolean }[],
  current: string[],
): string[] {
  const known = new Set(sources.map((s) => s.sourceKey));
  const kept = current.filter((k) => known.has(k));
  if (kept.length) return kept;
  return sources
    .filter((s) => s.isActive && (s.provider === "payos" || s.provider === "sepay"))
    .map((s) => s.sourceKey);
}

/** Ô gõ tay (khi key không có manage:sources): "a, b c" -> ["a","b","c"]. */
export const parseKeyList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Dòng "hiện có" cho một ô bí mật: không bao giờ có giá trị, chỉ 4 ký tự cuối + nguồn. */
export function currentHint(v: { source: string; configured?: boolean; last4?: string | null } | undefined): string {
  if (!v || !v.configured) return "Chưa có";
  const where = v.source === "db" ? "đã lưu ở trang này" : "từ env của server";
  return `Đang dùng …${v.last4 ?? "****"} (${where}). Để trống = giữ nguyên.`;
}

/** H-1 (ADR-160): Lưu = kiểm trước, lưu sau. Đăng ký FAILED -> server KHÔNG lưu gì, Shop vẫn chạy cấu hình cũ. */
export function saveHeadline(r: { saved: string[]; registration: { status: string } }): string {
  return r.registration.status === "FAILED"
    ? "Chưa lưu gì — Shop vẫn chạy bằng cấu hình cũ (vẫn nhận tiền như trước). Sửa theo dòng dưới rồi bấm Lưu lại."
    : `Đã lưu: ${r.saved.join(", ") || "(không đổi gì)"}.`;
}
