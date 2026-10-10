"use client";

// Trạng thái UI dùng chung giữa các section (thay cho DOM-query của main.js gốc).
import { create } from "zustand";

import type { Product } from "./api";

export const NAV_OFFSET = 78; // khớp main.js gốc: top - 78

export interface CategoryDef {
  key: string;
  label: string;
}

export const CATEGORIES: CategoryDef[] = [
  { key: "all", label: "Tất cả" },
  { key: "burgers", label: "Burger" },
  { key: "pizza", label: "Pizza" },
  { key: "chicken", label: "Gà rán" },
  { key: "wraps", label: "Wrap" },
  { key: "desserts", label: "Tráng miệng" },
  { key: "pasta", label: "Mì Ý" },
];

export const categoryLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label ?? key;

interface ShopUiState {
  products: Product[];
  productsError: string | null;
  filter: string;
  popItem: Product | null;
  searchOpen: boolean;
  cartOpen: boolean;
  checkoutOpen: boolean;
  setProducts: (p: Product[]) => void;
  setProductsError: (e: string | null) => void;
  setFilter: (f: string) => void;
  openPop: (p: Product) => void;
  closePop: () => void;
  setSearchOpen: (v: boolean) => void;
  setCartOpen: (v: boolean) => void;
  setCheckoutOpen: (v: boolean) => void;
  closeAll: () => void;
}

export const useShopUi = create<ShopUiState>()((set) => ({
  products: [],
  productsError: null,
  filter: "all",
  popItem: null,
  searchOpen: false,
  cartOpen: false,
  checkoutOpen: false,
  setProducts: (products) => set({ products, productsError: null }),
  setProductsError: (productsError) => set({ productsError }),
  setFilter: (filter) => set({ filter }),
  openPop: (popItem) => set({ popItem }),
  closePop: () => set({ popItem: null }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setCartOpen: (cartOpen) => set({ cartOpen }),
  setCheckoutOpen: (checkoutOpen) => set({ checkoutOpen }),
  closeAll: () => set({ popItem: null, searchOpen: false, cartOpen: false }),
}));

/** Cuộn mượt tới #id, trừ chiều cao navbar dính (như main.js gốc). */
export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - NAV_OFFSET, behavior: "smooth" });
}

/** Chặn cuộn body khi có lớp phủ đang mở. */
export function useAnyOverlayOpen() {
  return useShopUi((s) => s.searchOpen || s.cartOpen || s.checkoutOpen || s.popItem !== null);
}
