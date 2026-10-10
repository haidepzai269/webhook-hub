"use client";

// Giỏ hàng chỉ ở client (ADR-024): chỉ lưu {id, qty}. Giá/tổng hiển thị tính từ menu đã tải,
// số tiền chính thức luôn lấy từ response POST /orders của server.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import type { Product } from "./api";

export const MAX_QTY = 20; // khớp validate của apps/shop

export interface CartLine {
  id: string;
  qty: number;
}

interface CartState {
  items: CartLine[];
  add: (id: string, qty?: number) => void;
  setQty: (id: string, qty: number) => void;
  remove: (id: string) => void;
  clear: () => void;
}

// localStorage có thể ném lỗi (private mode, bị chặn) → bọc try/catch, mất giỏ cũng không sao.
const safeStorage: StateStorage = {
  getItem: (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* bỏ qua */
    }
  },
  removeItem: (k) => {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* bỏ qua */
    }
  },
};

const clampQty = (n: number) => Math.min(MAX_QTY, Math.max(1, Math.floor(n)));

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      items: [],
      add: (id, qty = 1) =>
        set((s) => {
          const found = s.items.find((l) => l.id === id);
          if (found) return { items: s.items.map((l) => (l.id === id ? { id, qty: clampQty(l.qty + qty) } : l)) };
          return { items: [...s.items, { id, qty: clampQty(qty) }] };
        }),
      setQty: (id, qty) =>
        set((s) => ({
          items:
            qty < 1
              ? s.items.filter((l) => l.id !== id)
              : s.items.map((l) => (l.id === id ? { id, qty: clampQty(qty) } : l)),
        })),
      remove: (id) => set((s) => ({ items: s.items.filter((l) => l.id !== id) })),
      clear: () => set({ items: [] }),
    }),
    {
      name: "sarab-cart-v1",
      // SSR render giỏ rỗng; client nạp localStorage SAU khi hydrate (ShopEffects) → không lệch HTML.
      skipHydration: true,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ items: s.items }),
      // Dữ liệu localStorage là đầu vào không tin cậy: lọc dòng hỏng.
      merge: (persisted, current) => {
        const raw = (persisted as { items?: unknown })?.items;
        const items = Array.isArray(raw)
          ? raw
              .filter((l): l is CartLine => typeof l?.id === "string" && Number.isFinite(l?.qty) && l.qty >= 1)
              .map((l) => ({ id: l.id, qty: clampQty(l.qty) }))
          : [];
        return { ...current, items };
      },
    },
  ),
);

export const cartCount = (items: CartLine[]) => items.reduce((n, l) => n + l.qty, 0);

/** Tạm tính để HIỂN THỊ. Bỏ qua món không còn trong menu. */
export function cartSubtotal(items: CartLine[], products: Product[]) {
  return items.reduce((sum, l) => sum + (products.find((p) => p.id === l.id)?.price ?? 0) * l.qty, 0);
}
