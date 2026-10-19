"use client"

import * as React from "react"
import { CalendarIcon } from "lucide-react"
import { enUS } from "react-day-picker/locale/en-US"
import { vi } from "react-day-picker/locale/vi"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DATE_PATTERN,
  dateToYmd,
  formatYmd,
  parseDateText,
  ymdToDate,
} from "@/lib/hub/date-input"
import { useLocale, useT } from "@/lib/i18n/use-t"

const CAL_LOCALE = { vi, en: enUS } as const

/**
 * Date Picker Input của shadcn (Field + InputGroup + Popover + Calendar), bản Radix (`asChild`, không `render`).
 * Giá trị chuẩn là `yyyy-MM-dd` theo giờ máy; chữ hiển thị/gõ theo ngôn ngữ đang chọn (vi `dd/MM/yyyy`, en `MM/dd/yyyy`).
 * Gõ sai khuôn: giữ chữ đang gõ, báo `onInvalidChange(true)` (cha hiện lỗi) và KHÔNG gọi `onValueChange` — giá trị
 * hợp lệ gần nhất không bị ghi đè. Phím ↓ mở lịch.
 */
export function DatePickerInput({
  value,
  onValueChange,
  invalid = false,
  errored = false,
  onInvalidChange,
  "aria-label": ariaLabel,
  id,
  className,
}: {
  value: string
  onValueChange: (ymd: string) => void
  /** Cha đang coi chữ trong ô là sai khuôn (do `onInvalidChange(true)` trước đó). */
  invalid?: boolean
  /** Cha đang báo lỗi liên quan ô này (vd "Từ" sau "Đến") — chỉ tô viền đỏ. */
  errored?: boolean
  onInvalidChange?: (invalid: boolean) => void
  "aria-label": string
  id?: string
  className?: string
}) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = React.useState(false)
  // Chữ đang gõ; null = hiển thị theo `value` (đổi ngôn ngữ / URL đổi thì chữ tự theo).
  const [draft, setDraft] = React.useState<string | null>(null)
  const draftParsed = draft === null ? undefined : parseDateText(draft, locale)
  // Giá trị đổi từ ngoài (URL, nút Xoá, chọn trên lịch) khác chữ đang gõ -> bỏ chữ nháp.
  React.useEffect(() => {
    if (draft === null) return
    const p = parseDateText(draft, locale)
    if (p === null ? !invalid : p !== value) setDraft(null)
  }, [value, invalid, locale, draft])

  const text = draft ?? formatYmd(value, locale)
  const selected = ymdToDate(value)
  const pick = (ymd: string) => {
    setDraft(null)
    onInvalidChange?.(false)
    onValueChange(ymd)
    setOpen(false)
  }

  return (
    <InputGroup className={className} data-slot="date-picker-input">
      <InputGroupInput
        id={id}
        value={text}
        inputMode="numeric"
        autoComplete="off"
        placeholder={DATE_PATTERN[locale]}
        aria-label={ariaLabel}
        aria-invalid={errored || invalid || draftParsed === null}
        className="max-sm:h-10 sm:text-xs"
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          const p = parseDateText(next, locale)
          onInvalidChange?.(p === null)
          if (p !== null) onValueChange(p)
        }}
        onBlur={() => {
          if (draft !== null && draftParsed !== null) setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setOpen(true)
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <InputGroupButton
              variant="ghost"
              size="icon-xs"
              aria-label={t("admin.date-picker.open")}
              className="max-sm:size-10"
            >
              <CalendarIcon />
            </InputGroupButton>
          </PopoverTrigger>
          <PopoverContent
            className="w-auto gap-0 overflow-hidden p-0 max-sm:w-[calc(100vw-1rem)]"
            align="end"
            alignOffset={-8}
            sideOffset={10}
            collisionPadding={8}
          >
            <Calendar
              mode="single"
              required={false}
              autoFocus
              locale={CAL_LOCALE[locale]}
              selected={selected}
              defaultMonth={selected}
              onSelect={(d) => pick(d ? dateToYmd(d) : "")}
              className="max-sm:w-full max-sm:[--cell-size:--spacing(10)] sm:[--cell-size:--spacing(8)]"
              classNames={{ root: "w-full sm:w-fit" }}
            />
            <div className="border-t p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full max-sm:h-10"
                onClick={() => pick(dateToYmd(new Date()))}
              >
                {t("admin.date-picker.today")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </InputGroupAddon>
    </InputGroup>
  )
}
