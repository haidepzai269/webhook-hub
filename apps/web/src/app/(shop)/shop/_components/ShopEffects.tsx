"use client";

import { useEffect, useState } from "react";

import AOS from "aos";

import { useCart } from "@/lib/shop/cart";
import { useAnyOverlayOpen, useShopUi } from "@/lib/shop/ui";
import { bodyScrollLock } from "@/lib/ui/scroll-lock";

/** Hiệu ứng toàn trang của main.js gốc: AOS, Esc, khoá cuộn body, dọn giỏ. Không render gì. */
export function ShopEffects() {
  const overlayOpen = useAnyOverlayOpen();
  const products = useShopUi((s) => s.products);

  useEffect(() => {
    void useCart.persist.rehydrate();
    AOS.init({ duration: 680, once: true, offset: 55 });
  }, []);

  // Thẻ menu tải bất đồng bộ → AOS cần quét lại DOM
  useEffect(() => {
    if (products.length > 0) AOS.refreshHard();
  }, [products]);

  // Món trong giỏ (localStorage) không còn trong menu → bỏ, tránh POST /orders bị 400
  useEffect(() => {
    if (products.length === 0) return;
    const { items, remove } = useCart.getState();
    for (const l of items) if (!products.some((p) => p.id === l.id)) remove(l.id);
  }, [products]);

  // Khoá cuộn nền (đếm tham chiếu + bù bề rộng thanh cuộn → trang không giật khi mở giỏ/popup)
  useEffect(() => {
    if (!overlayOpen) return;
    bodyScrollLock.lock();
    return () => bodyScrollLock.unlock();
  }, [overlayOpen]);

  // Esc đóng tìm kiếm / popup món / giỏ (modal thanh toán & gallery tự xử lý Esc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useShopUi.getState().closeAll();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}

export function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 300);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <button
      type="button"
      id="btt"
      className={show ? "show" : ""}
      aria-label="Lên đầu trang"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
    >
      <i className="fas fa-chevron-up" />
    </button>
  );
}
