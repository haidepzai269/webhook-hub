"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription } from "@/components/ui/field";

/** Ô "nhận cả sự kiện chưa xác thực" — dùng chung cho form endpoint và form subscription (cùng markup, khác nhãn). */
export function AcceptUnverifiedField({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <Field className="gap-1.5">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
        {label}
      </label>
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );
}
