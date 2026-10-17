"use client";

import { useT } from "@/lib/i18n/use-t";
import { Switch } from "@/components/ui/switch";

/** Công tắc "Giữ lâu" (dùng chung trang Dung lượng + trang Nguồn). Câu đánh đổi nằm ở `title` + mô tả của khối. */
export function KeepLongerSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs" title={t("page.storage.keep-longer.hint")}>
      <Switch className="h-4 w-7 [&_[data-slot=switch-thumb]]:size-3 [&_[data-slot=switch-thumb]]:data-checked:translate-x-[14px]" checked={checked} disabled={disabled} onCheckedChange={onChange} />
      {t("page.storage.keep-longer")}
    </label>
  );
}
