"use client";

import { create } from "zustand";

import type { AuthMe } from "./client";

/**
 * Người đang đăng nhập (`GET /auth/me`, AuthGuard nạp một lần). CB4: `isOperator` quyết định chuông, banner, toast,
 * mục "Cảnh báo" — người không phải operator KHÔNG thấy và KHÔNG gọi `/api/v1/alerts*` (server vẫn chặn 403
 * `operator_required`; đây chỉ là để không bắn request vô ích).
 */
interface MeState {
  me: AuthMe | null;
}

export const useMeStore = create<MeState>(() => ({ me: null }));

export function useIsOperator(): boolean {
  return useMeStore((s) => s.me?.user.isOperator === true);
}

/**
 * QT6 (SPEC-han-muc-dung-luong E3, ADR-190): ai thấy chuông / banner / toast / trang Cảnh báo — operator (mọi cảnh báo) HOẶC
 * owner của ít nhất một project (server chỉ trả cảnh báo dung lượng của project họ là owner). Developer/viewer: không.
 */
export function useCanSeeAlerts(): boolean {
  return useMeStore((s) => s.me?.user.isOperator === true || (s.me?.memberships ?? []).some((m) => m.role === "owner"));
}

export function useMeId(): string | null {
  return useMeStore((s) => s.me?.user.id ?? null);
}
