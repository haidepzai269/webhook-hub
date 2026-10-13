"use client";

import { useT } from "@/lib/i18n/use-t";

/** Công tắc "Giữ lâu" (dùng chung trang Dung lượng + trang Nguồn). Câu đánh đổi nằm ở `title` + mô tả của khối. */
export function KeepLongerSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs" title={t("page.storage.keep-longer.hint")}>
      <input
        type="checkbox"
        role="switch"
        className="size-3.5 accent-primary disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {t("page.storage.keep-longer")}
    </label>
  );
}
