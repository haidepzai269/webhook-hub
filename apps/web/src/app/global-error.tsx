"use client";

import { useEffect, useMemo, useState } from "react";

import { ErrorScreen } from "@/components/admin/error-screen";
import { getClientCookie } from "@/lib/cookie.client";
import { createT, DEFAULT_LOCALE, LOCALES, type Locale } from "@/lib/i18n/dictionary";

import "./(admin)/globals.css";

/**
 * Lỗi ở chính root layout (ADR-264): Next thay TOÀN BỘ cây, nên phải tự có <html>/<body> và không có provider nào.
 * Ngôn ngữ đọc từ cookie `language` sau khi mount (SSR dùng mặc định -> không lệch hydrate).
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    const c = getClientCookie("language");
    if (c && (LOCALES as readonly string[]).includes(c)) setLocale(c as Locale);
  }, []);
  const t = useMemo(() => createT(locale), [locale]);
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <ErrorScreen error={error} reset={reset} t={t} />
      </body>
    </html>
  );
}
