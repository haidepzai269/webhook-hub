"use client";

import { useEffect, useState } from "react";

import { cartCount, useCart } from "@/lib/shop/cart";
import { scrollToId, useShopUi } from "@/lib/shop/ui";

const LINKS = [
  { id: "hero", label: "Trang chủ" },
  { id: "about", label: "Giới thiệu" },
  { id: "menu", label: "Thực đơn" },
  { id: "chefs", label: "Đầu bếp" },
  { id: "reservation", label: "Đặt bàn" },
  { id: "testimonials", label: "Đánh giá" },
  { id: "contact-section", label: "Liên hệ" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState("hero");
  const [menuOpen, setMenuOpen] = useState(false); // thay Bootstrap Collapse JS
  const count = useCart((s) => cartCount(s.items));
  const setSearchOpen = useShopUi((s) => s.setSearchOpen);
  const setCartOpen = useShopUi((s) => s.setCartOpen);

  // main.js: nav.scrolled + scroll-spy active link
  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 60);
      for (const sec of document.querySelectorAll<HTMLElement>("section[id]")) {
        const top = sec.offsetTop - 110;
        if (window.scrollY >= top && window.scrollY < top + sec.offsetHeight) {
          if (LINKS.some((l) => l.id === sec.id)) setActive(sec.id);
        }
      }
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const go = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setMenuOpen(false);
    setTimeout(() => scrollToId(id), 50);
  };

  return (
    <nav className={`navbar navbar-expand-lg${scrolled ? " scrolled" : ""}`} id="nav">
      <div className="container">
        <a className="navbar-brand" href="#hero" onClick={(e) => go(e, "hero")}>
          <div className="blogo">
            <div className="bico">
              <i className="fas fa-utensils" />
            </div>
            <div>
              <div className="bname">
                Sar<span>ab</span>
              </div>
              <div className="bsub">Đồ ăn nhanh &amp; Nhà hàng</div>
            </div>
          </div>
        </a>
        <button
          className="navbar-toggler border-0"
          type="button"
          aria-controls="navmenu"
          aria-expanded={menuOpen}
          aria-label="Mở menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <i className="fas fa-bars" style={{ color: "var(--primary)", fontSize: "1.35rem" }} />
        </button>
        <div className={`collapse navbar-collapse${menuOpen ? " show" : ""}`} id="navmenu">
          <ul className="navbar-nav mx-auto">
            {LINKS.map((l) => (
              <li className="nav-item" key={l.id}>
                <a
                  className={`nav-link${active === l.id ? " active" : ""}`}
                  href={`#${l.id}`}
                  onClick={(e) => go(e, l.id)}
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="d-flex align-items-center gap-1">
            <button
              id="navSearchBtn"
              type="button"
              title="Tìm món"
              aria-label="Tìm món"
              onClick={() => setSearchOpen(true)}
            >
              <i className="fas fa-search" />
            </button>
            <button
              id="navCartBtn"
              type="button"
              title="Giỏ hàng"
              aria-label={`Giỏ hàng (${count} món)`}
              onClick={() => {
                setMenuOpen(false);
                setCartOpen(true);
              }}
            >
              <i className="fas fa-shopping-cart" />
              {count > 0 && <span className="navccount">{count}</span>}
            </button>
            <a href="#menu" className="nav-link nav-cta" onClick={(e) => go(e, "menu")}>
              <i className="fas fa-shopping-bag me-1" />
              Đặt món
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}
