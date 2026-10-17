"use client";

import { useEffect, useRef, useState } from "react";

import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { isoToLocalInput, localInputToIso, localInputToIsoEnd, timeRangeError } from "@/lib/hub/list-url";
import { useT } from "@/lib/i18n/use-t";

/**
 * Khoảng thời gian (giờ máy người xem) — ghi URL dạng ISO UTC. "Đến" GỒM cả phút đã chọn (…:59.999).
 * Gõ/chọn được gom 500ms rồi mới ghi URL (không bắn truy vấn theo từng phím); "Từ" sau "Đến" -> báo ngay dưới ô,
 * KHÔNG ghi URL (không gửi lên để nhận 400).
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
  const [fromLocal, setFromLocal] = useState(isoToLocalInput(from));
  const [toLocal, setToLocal] = useState(isoToLocalInput(to));
  // URL đổi từ ngoài (Bỏ lọc, Back) -> ô theo URL; đổi do chính ô ghi -> bỏ qua.
  const written = useRef({ from, to });
  useEffect(() => {
    if (written.current.from === from && written.current.to === to) return;
    written.current = { from, to };
    edited.current = false; // giá trị mới đến từ URL, không phải người xem
    setFromLocal(isoToLocalInput(from));
    setToLocal(isoToLocalInput(to));
  }, [from, to]);

  // Ref: trang cha truyền hàm mới mỗi lần render (trang trực tiếp render liên tục) — không được reset hẹn giờ.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const nextFrom = localInputToIso(fromLocal);
  const nextTo = localInputToIsoEnd(toLocal);
  const error = timeRangeError(nextFrom, nextTo);
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

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-muted-foreground text-xs">
        <Input
          type="datetime-local"
          aria-label={t("admin.time-range.from")}
          aria-invalid={Boolean(error)}
          className="h-8 w-48 text-xs"
          value={fromLocal}
          onChange={(e) => {
            edited.current = true;
            setFromLocal(e.target.value);
          }}
        />
        <span>→</span>
        <Input
          type="datetime-local"
          aria-label={t("admin.time-range.to")}
          aria-invalid={Boolean(error)}
          className="h-8 w-48 text-xs"
          value={toLocal}
          onChange={(e) => {
            edited.current = true;
            setToLocal(e.target.value);
          }}
        />
      </div>
      {error && <FieldError className="text-xs">{t(error)}</FieldError>}
    </div>
  );
}
