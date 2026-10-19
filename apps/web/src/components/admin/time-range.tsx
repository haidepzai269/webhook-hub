"use client";

import { useEffect, useRef, useState } from "react";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { composeLocal, DATE_PATTERN, DEFAULT_TIME, parseTimeText, splitLocal } from "@/lib/hub/date-input";
import { isoToLocalInput, localInputToIso, localInputToIsoEnd, timeRangeError } from "@/lib/hub/list-url";
import { useLocale, useT } from "@/lib/i18n/use-t";

/**
 * Khoảng thời gian (giờ máy người xem) — ghi URL dạng ISO UTC. "Đến" GỒM cả phút đã chọn (…:59.999).
 * Gõ/chọn được gom 500ms rồi mới ghi URL (không bắn truy vấn theo từng phím); "Từ" sau "Đến" -> báo ngay dưới ô,
 * KHÔNG ghi URL (không gửi lên để nhận 400). Gõ sai khuôn ngày/giờ cũng báo ngay và không ghi URL.
 *
 * Mỗi đầu = ô ngày (gõ tay hoặc lịch, ADR-266) + ô giờ `HH:mm` tự làm (24 giờ). Không dùng `<input type="time">`:
 * nó theo giờ 12/24 của hệ điều hành (en-US hiện AM/PM, lệch với `HH:mm` của URL/ô ngày) và trên điện thoại mở bánh xe
 * của hệ điều hành — đúng loại picker gốc vừa bị bỏ vì văng khỏi khung / không đồng bộ giao diện.
 */
export function TimeRange({
  from,
  to,
  onChange,
}: {
  from?: string;
  to?: string;
  onChange: (r: { from?: string | null; to?: string | null }) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const init = { from: splitLocal(isoToLocalInput(from)), to: splitLocal(isoToLocalInput(to)) };
  const [fromYmd, setFromYmd] = useState(init.from.ymd);
  const [fromHm, setFromHm] = useState(init.from.hm);
  const [toYmd, setToYmd] = useState(init.to.ymd);
  const [toHm, setToHm] = useState(init.to.hm);
  // Ô đang chứa chữ sai khuôn (giá trị hợp lệ gần nhất vẫn giữ ở state trên nhưng KHÔNG được ghi URL).
  const [bad, setBad] = useState({ fromDate: false, fromTime: false, toDate: false, toTime: false });
  const setBadOf = (k: keyof typeof bad) => (v: boolean) => setBad((b) => (b[k] === v ? b : { ...b, [k]: v }));

  // URL đổi từ ngoài (Bỏ lọc, Back) -> ô theo URL; đổi do chính ô ghi -> bỏ qua.
  const written = useRef({ from, to });
  useEffect(() => {
    if (written.current.from === from && written.current.to === to) return;
    written.current = { from, to };
    edited.current = false; // giá trị mới đến từ URL, không phải người xem
    const f = splitLocal(isoToLocalInput(from));
    const e = splitLocal(isoToLocalInput(to));
    setFromYmd(f.ymd);
    setFromHm(f.hm);
    setToYmd(e.ymd);
    setToHm(e.hm);
    setBad({ fromDate: false, fromTime: false, toDate: false, toTime: false });
  }, [from, to]);

  // Ref: trang cha truyền hàm mới mỗi lần render (trang trực tiếp render liên tục) — không được reset hẹn giờ.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const nextFrom = localInputToIso(composeLocal(fromYmd, fromHm, "start"));
  const nextTo = localInputToIsoEnd(composeLocal(toYmd, toHm, "end"));
  const fromLabel = t("admin.time-range.from");
  const toLabel = t("admin.time-range.to");
  const fmt = DATE_PATTERN[locale];
  const order = timeRangeError(nextFrom, nextTo);
  const problems = [
    bad.fromDate && t("admin.time-range.date-invalid", { field: fromLabel, format: fmt }),
    bad.fromTime && t("admin.time-range.time-invalid", { field: fromLabel }),
    bad.toDate && t("admin.time-range.date-invalid", { field: toLabel, format: fmt }),
    bad.toTime && t("admin.time-range.time-invalid", { field: toLabel }),
    order && t(order),
  ];
  const error = problems.find(Boolean) || null;
  // Chỉ ghi URL sau khi NGƯỜI XEM sửa ô: mở link chia sẻ có `from=…:30.123Z` không bị làm tròn phút rồi ghi đè.
  const edited = useRef(false);
  useEffect(() => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: ref đổi trong onChange — biome không thấy
    if (!edited.current || error || (nextFrom === from && nextTo === to)) return;
    const timer = setTimeout(() => {
      written.current = { from: nextFrom, to: nextTo };
      onChangeRef.current({ from: nextFrom ?? null, to: nextTo ?? null });
    }, 500);
    return () => clearTimeout(timer);
  }, [nextFrom, nextTo, error, from, to]);

  const edit = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    edited.current = true;
    fn(...a);
  };
  // Chọn ngày mà chưa có giờ -> điền sẵn giờ mặc định (đầu ngày / cuối ngày) để người xem thấy rõ mốc đang lọc.
  const setFromDay = edit((ymd: string) => {
    setFromYmd(ymd);
    setFromHm((h) => (ymd ? h || DEFAULT_TIME.start : ""));
  });
  const setToDay = edit((ymd: string) => {
    setToYmd(ymd);
    setToHm((h) => (ymd ? h || DEFAULT_TIME.end : ""));
  });
  const clearFrom = edit(() => {
    setFromYmd("");
    setFromHm("");
    setBad((b) => ({ ...b, fromDate: false, fromTime: false }));
  });
  const clearTo = edit(() => {
    setToYmd("");
    setToHm("");
    setBad((b) => ({ ...b, toDate: false, toTime: false }));
  });

  // Dưới `sm` (ADR-261): "Từ" và "Đến" xếp 2 hàng full-width, có nhãn ngắn, bỏ mũi tên; từ `sm` giữ một hàng như cũ.
  const rowCls = "min-w-0 items-center gap-1.5 sm:w-auto sm:gap-1";
  const labelCls = "w-10 shrink-0 sm:hidden";
  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 sm:w-auto">
      <div className="flex w-full min-w-0 flex-col gap-1.5 text-muted-foreground text-xs sm:w-auto sm:flex-row sm:items-center sm:gap-1">
        <Field orientation="horizontal" className={rowCls}>
          <span className={labelCls} aria-hidden>
            {fromLabel}
          </span>
          <DatePickerInput
            aria-label={`${fromLabel} — ${t("admin.time-range.date")}`}
            value={fromYmd}
            onValueChange={setFromDay}
            invalid={bad.fromDate}
            errored={Boolean(error)}
            onInvalidChange={edit(setBadOf("fromDate"))}
            className="min-w-0 flex-1 max-sm:h-10 sm:w-36 sm:flex-none"
          />
          <TimeInput
            aria-label={`${fromLabel} — ${t("admin.time-range.time")}`}
            value={fromHm}
            disabled={!fromYmd}
            edge="start"
            onValueChange={edit(setFromHm)}
            invalid={bad.fromTime}
            errored={Boolean(error)}
            onInvalidChange={edit(setBadOf("fromTime"))}
          />
          <ClearButton
            label={t("admin.time-range.clear", { field: fromLabel })}
            visible={Boolean(fromYmd) || bad.fromDate}
            onClick={clearFrom}
          />
        </Field>
        <span className="max-sm:hidden">→</span>
        <Field orientation="horizontal" className={rowCls}>
          <span className={labelCls} aria-hidden>
            {toLabel}
          </span>
          <DatePickerInput
            aria-label={`${toLabel} — ${t("admin.time-range.date")}`}
            value={toYmd}
            onValueChange={setToDay}
            invalid={bad.toDate}
            errored={Boolean(error)}
            onInvalidChange={edit(setBadOf("toDate"))}
            className="min-w-0 flex-1 max-sm:h-10 sm:w-36 sm:flex-none"
          />
          <TimeInput
            aria-label={`${toLabel} — ${t("admin.time-range.time")}`}
            value={toHm}
            disabled={!toYmd}
            edge="end"
            onValueChange={edit(setToHm)}
            invalid={bad.toTime}
            errored={Boolean(error)}
            onInvalidChange={edit(setBadOf("toTime"))}
          />
          <ClearButton
            label={t("admin.time-range.clear", { field: toLabel })}
            visible={Boolean(toYmd) || bad.toDate}
            onClick={clearTo}
          />
        </Field>
      </div>
      {error && <FieldError className="text-xs">{error}</FieldError>}
    </div>
  );
}

/** Nút xoá một đầu — luôn chiếm chỗ (ẩn bằng `invisible`) để hàng không nhảy khi có/không có giá trị. */
function ClearButton({ label, visible, onClick }: { label: string; visible: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      disabled={!visible}
      className={`shrink-0 max-sm:size-10 sm:size-8 ${visible ? "" : "invisible"}`}
      onClick={onClick}
    >
      <X />
    </Button>
  );
}

/** Ô giờ `HH:mm` 24 giờ gõ tay. Sai khuôn: giữ chữ đang gõ, báo cha, không đổi giá trị hợp lệ gần nhất. */
function TimeInput({
  value,
  onValueChange,
  invalid,
  errored,
  onInvalidChange,
  edge,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (hm: string) => void;
  invalid: boolean;
  errored: boolean;
  onInvalidChange: (invalid: boolean) => void;
  edge: keyof typeof DEFAULT_TIME;
  disabled: boolean;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? undefined : parseTimeText(draft);
  // Giá trị đổi từ ngoài (URL, chọn ngày, Xoá) khác chữ đang gõ -> bỏ chữ nháp.
  useEffect(() => {
    if (draft === null) return;
    const p = parseTimeText(draft);
    if (p === null ? !invalid : p !== "" && p !== value) setDraft(null);
  }, [value, invalid, draft]);
  return (
    <Input
      inputMode="numeric"
      autoComplete="off"
      placeholder="HH:mm"
      maxLength={5}
      aria-label={ariaLabel}
      aria-invalid={errored || invalid || parsed === null}
      disabled={disabled}
      value={draft ?? value}
      className="w-[4.75rem] shrink-0 text-center tabular-nums max-sm:h-10 sm:w-16 sm:text-xs md:text-xs"
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        const p = parseTimeText(next);
        onInvalidChange(p === null);
        if (p !== null && p !== "") onValueChange(p);
      }}
      onBlur={() => {
        if (draft === null || parsed === null) return;
        setDraft(null);
        // Để trống = giờ mặc định của đầu này; ghi ra ô để người xem thấy đúng mốc đang lọc.
        if (parsed === "") onValueChange(DEFAULT_TIME[edge]);
      }}
    />
  );
}
