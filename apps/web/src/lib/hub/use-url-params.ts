"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePathname, useSearchParams } from "next/navigation";

import { clearParams, type ParamSpecs, readParams, withCursor, withFilter } from "./list-url";

/**
 * ADR-163: URL là nguồn sự thật của bộ lọc + cursor (F5 / gửi link giữ nguyên). Ghi bằng History API gốc — Next
 * đồng bộ `useSearchParams` theo `pushState`/`replaceState` mà không tải lại trang. Đổi lọc = replace (không rải
 * lịch sử theo từng phím gõ); Trước/Sau = push (nút Back của trình duyệt quay đúng trang trước).
 * Component dùng hook này phải nằm trong <Suspense> (useSearchParams).
 */
export function useUrlParams<S extends ParamSpecs>(specs: S) {
  const sp = useSearchParams();
  const pathname = usePathname();
  const search = sp.toString();
  const values = useMemo(() => readParams(new URLSearchParams(search), specs), [search, specs]);
  const go = useCallback(
    (next: string, push: boolean) => {
      const url = `${pathname}${next}`;
      if (push) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [pathname],
  );
  const setFilter = useCallback((patch: Record<string, string | null | undefined>) => go(withFilter(search, patch), false), [go, search]);
  const setCursor = useCallback((c: { before?: string | null; after?: string | null }) => go(withCursor(search, c), true), [go, search]);
  // "Bỏ lọc" tăng `resetToken`: ô đang gõ dở (chưa hợp lệ, chưa lên URL) và trạng thái lỗi của TimeRange cũng xoá.
  const [resetToken, setResetToken] = useState(0);
  const clear = useCallback(() => {
    go(clearParams(search, specs), false);
    setResetToken((n) => n + 1);
  }, [go, search, specs]);
  return { values, setFilter, setCursor, clear, resetToken };
}

/**
 * Ô gõ tự do gắn với MỘT khoá URL (type, id, người làm…): ghi URL sau `delayMs`, CHỈ khi giá trị hợp lệ hoặc rỗng —
 * đang gõ dở (chưa hợp lệ) thì URL giữ nguyên, ô không bị xoá. URL đổi từ NGOÀI (Back, Bỏ lọc, link) thì ô đồng bộ
 * theo; URL đổi do chính ô này ghi thì KHÔNG đồng bộ ngược (không giật con trỏ / không ghi đè chữ đang gõ).
 */
export function useDebouncedUrlInput(
  urlValue: string | undefined,
  isValid: (v: string) => boolean,
  write: (v: string | null) => void,
  delayMs = 350,
  resetToken = 0,
): [string, (v: string) => void] {
  const [input, setInput] = useState(urlValue ?? "");
  // `resetToken` đổi (Bỏ lọc) -> ô về đúng URL, kể cả chữ gõ dở chưa từng lên URL.
  const lastReset = useRef(resetToken);
  if (lastReset.current !== resetToken) {
    lastReset.current = resetToken;
    setInput(urlValue ?? "");
  }
  const lastWritten = useRef<string | undefined>(urlValue);
  // Ref: hàm ghi/kiểm có thể đổi danh tính mỗi render — không được reset hẹn giờ.
  const fns = useRef({ isValid, write });
  fns.current = { isValid, write };
  useEffect(() => {
    if (urlValue === lastWritten.current) return;
    lastWritten.current = urlValue;
    setInput(urlValue ?? "");
  }, [urlValue]);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = input.trim();
      if (next !== "" && !fns.current.isValid(next)) return;
      if (next === (urlValue ?? "")) return;
      lastWritten.current = next || undefined;
      fns.current.write(next || null);
    }, delayMs);
    return () => clearTimeout(t);
  }, [input, urlValue, delayMs]);
  return [input, setInput];
}
