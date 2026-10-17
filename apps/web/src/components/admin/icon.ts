/**
 * Cỡ icon Lucide dùng chung (ADR-247): `ICON` 16px cho mọi chỗ, `ICON_SM` 13px chỉ trong pill.
 * Nét 1.75 cũng được CSS `.lucide { stroke-width: 1.75 }` áp mặc định (globals.css), nên icon không truyền
 * `strokeWidth` vẫn khớp. `flow/tokens` re-export để import cũ không vỡ.
 */
export const ICON = { size: 16, strokeWidth: 1.75 } as const;
export const ICON_SM = { size: 13, strokeWidth: 1.75 } as const;
