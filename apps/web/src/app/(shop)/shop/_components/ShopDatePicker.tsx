"use client";

import "react-day-picker/style.css";
import "./ShopDatePicker.css";

import { useRef, useState } from "react";

import { Popover } from "radix-ui";
import { DayPicker } from "react-day-picker";
import { vi } from "react-day-picker/locale/vi";

import { dateToYmd, formatYmd, parseDateText, ymdToDate } from "@/lib/hub/date-input";

/**
 * Ô ngày của storefront (ADR-266): gõ `dd/MM/yyyy` hoặc mở lịch tiếng Việt (tuần bắt đầu thứ Hai), thay `type="date"` gốc.
 * Cùng logic gõ/parse (`lib/hub/date-input`) và react-day-picker với bộ ô của console, nhưng KHÔNG dùng shadcn/Tailwind
 * (root layout storefront không có — ADR-025). Giá trị ra vẫn là `yyyy-MM-dd` như `<input type="date">`; `required` giữ
 * nguyên nhờ ô chữ có `required` + `setCustomValidity` khi sai khuôn.
 */
export function ShopDatePicker({
  id,
  value,
  onChange,
  required,
}: {
  id: string;
  value: string;
  onChange: (ymd: string) => void;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = ymdToDate(value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="sdp">
          <input
            ref={input}
            id={id}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className="fctrl"
            placeholder="dd/MM/yyyy"
            required={required}
            value={draft ?? formatYmd(value, "vi")}
            onChange={(e) => {
              const text = e.target.value;
              const ymd = parseDateText(text, "vi");
              e.target.setCustomValidity(ymd === null ? "Ngày không hợp lệ — gõ theo dạng dd/MM/yyyy" : "");
              setDraft(ymd === null ? text : null);
              if (ymd !== null) onChange(ymd);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
              }
            }}
          />
          <Popover.Trigger asChild>
            <button type="button" className="sdp-btn" aria-label="Mở lịch chọn ngày">
              <i className="fas fa-calendar-alt" />
            </button>
          </Popover.Trigger>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content className="sdp-pop" align="end" sideOffset={6} collisionPadding={8}>
          <DayPicker
            mode="single"
            autoFocus
            locale={vi}
            selected={selected}
            defaultMonth={selected}
            onSelect={(d) => {
              setDraft(null);
              input.current?.setCustomValidity("");
              onChange(d ? dateToYmd(d) : "");
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
