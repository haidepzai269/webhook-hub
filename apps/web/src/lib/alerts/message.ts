/**
 * CB4 (SPEC-canh-bao-nhan-dinh §2, §4, §7): dựng câu `{ title, message, fix }` của một cảnh báo từ `rule` + `facts`, phía
 * client, theo ngôn ngữ đang chọn. API chỉ trả mã + số liệu.
 * CB5: phần lõi (câu từng luật + hàm dựng) chuyển về `libs/common/src/alerts/text.ts` để email của worker dùng CHUNG một
 * nguồn câu với console. File này chỉ bọc lại với kiểu của từ điển web (`MessageKey`, `TranslateFn`, `Locale`).
 * TS thuần (không React, không alias `@/`) để jest gốc test thẳng.
 */
import * as core from "@hub/common/alerts/text";

import type { MessageKey, TranslateFn } from "../i18n/dictionary";
import type { Locale } from "../i18n/locales";
import type { AlertSubjectType } from "./types";

export interface AlertLike {
  rule: string;
  facts: Record<string, unknown> | null | undefined;
  subjectType: AlertSubjectType;
  subjectId: string;
}

export interface MessageContext {
  locale: Locale;
  /** Mốc "bây giờ" (ms) — tiêm vào để test ổn định. */
  now: number;
  /** Tên đối tượng nếu biết (đích/nguồn của project); không biết -> nhãn loại + id ngắn. */
  subjectName?: string | null;
}

export type AlertText = core.AlertText;
export type FailureClass = core.FailureClass;

/** `TranslateFn` của web chỉ nhận `MessageKey`; lõi gọi bằng khoá chuỗi đã có trong từ điển (dictionary.spec kiểm). */
const loose = (t: TranslateFn): core.AlertTextT => t as unknown as core.AlertTextT;

export const ruleSegment = core.ruleSegment;
export const FAILURE_CLASSES = core.FAILURE_CLASSES;
export const failureBreakdown = core.failureBreakdown;
export const providerDisplayName = core.providerDisplayName;

/** Khoá `alerts.rule.<luật>.<phần>` — ép kiểu một chỗ; `hasKey` kiểm thật trong từ điển trước khi dùng. */
export function ruleKey(rule: string, part: string): MessageKey {
  return core.ruleKey(rule, part) as MessageKey;
}

/** Thời lượng gọn theo ngôn ngữ: 45 giây · 12 phút · 3 giờ · 2 ngày. */
export function formatDuration(ms: number, t: TranslateFn): string {
  return core.formatDuration(ms, loose(t));
}

/** Mốc ngắn: "14:02" nếu trong 20 giờ qua/tới, không thì kèm ngày "12/10 14:02" (múi giờ trình duyệt). */
export function formatClock(at: number, ctx: Pick<MessageContext, "locale" | "now">): string {
  return core.formatClock(at, ctx);
}

/** Nhãn đối tượng: tên nếu biết; cấp dự án -> "Toàn dự án"; không thì "Đích 3fa2c1d0". */
export function subjectLabel(
  a: Pick<AlertLike, "subjectType" | "subjectId">,
  t: TranslateFn,
  name?: string | null,
): string {
  return core.subjectLabel(a, loose(t), name);
}

/** Câu "cách sửa" của destination.failing theo loại lỗi TRỘI (429 -> chậm lại, 3xx -> URL, không phản hồi -> mạng). */
export function failingFixKey(byClass: unknown): MessageKey {
  return core.failingFixKey(byClass) as MessageKey;
}

/** Dựng câu cho một cảnh báo (lõi dùng chung với email). */
export function buildAlertText(a: AlertLike, t: TranslateFn, ctx: MessageContext): AlertText {
  return core.buildAlertText(a, loose(t), ctx);
}

/** Tên ngắn của luật (bộ lọc, Cài đặt) — luật lạ -> chính mã luật. */
export function ruleName(rule: string, t: TranslateFn): string {
  return core.ruleName(rule, loose(t));
}
