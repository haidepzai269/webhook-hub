"use client";

import { type CSSProperties, useMemo, useRef } from "react";

import { assignUnroll, createUnrollMemory, isUnrolling, resetUnroll, type UnrollMemory } from "./unroll";

/**
 * Hook mỏng quanh `assignUnroll` (unroll.ts): trả `rowProps(key)` = `{ className, style }` cho từng dòng.
 * `keys` PHẢI là danh sách ĐẦY ĐỦ đã nạp (chưa lọc phía client): khoá vắng mặt bị quên, nên truyền tập đã lọc thì gõ ô
 * lọc làm dòng ẩn rồi hiện lại bị coi là dòng mới. Tập con hiển thị chỉ việc gọi `rowProps` cho các khoá của nó. `resetKey`
 * đổi (bộ lọc, project) -> quên hết, danh sách mới mở ra như một lô. CSS ở styles/unroll.css (tắt khi
 * prefers-reduced-motion).
 */
export function useUnroll(keys: readonly string[], opts: { resetKey?: string; animateInitial?: boolean } = {}) {
  const mem = useRef<UnrollMemory | null>(null);
  const lastReset = useRef<string | undefined>(opts.resetKey);
  mem.current ??= createUnrollMemory();
  if (lastReset.current !== opts.resetKey) {
    lastReset.current = opts.resetKey;
    resetUnroll(mem.current);
  }
  const joined = keys.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `joined` là dấu vân tay của `keys`
  const fates = useMemo(() => assignUnroll(mem.current as UnrollMemory, keys, Date.now(), { animateInitial: opts.animateInitial }), [joined, opts.resetKey]);
  const now = Date.now();
  return (key: string): { className?: string; style?: CSSProperties } => {
    const f = fates.get(key);
    if (!f || !isUnrolling(f, now)) return {};
    return { className: "unroll-row", style: { "--unroll-delay": `${f.delayMs}ms` } as CSSProperties };
  };
}
