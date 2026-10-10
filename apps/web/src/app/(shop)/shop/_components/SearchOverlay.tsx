"use client";

import { useEffect, useRef, useState } from "react";

import { formatVnd } from "@/lib/shop/api";
import { CATEGORIES, categoryLabel, scrollToId, useShopUi } from "@/lib/shop/ui";

// Ảnh minh hoạ cho chip danh mục (như template gốc)
const CAT_IMG: Record<string, number> = { all: 1, burgers: 1, pizza: 2, chicken: 3, wraps: 4, desserts: 5, pasta: 6 };
const TRENDING = ["Burger smash", "Gà cay", "Pizza", "Lava", "Truffle", "Wrap"];

// Bỏ dấu để "ga ran" khớp "Gà rán"
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

export function SearchOverlay() {
  const open = useShopUi((s) => s.searchOpen);
  const products = useShopUi((s) => s.products);
  const filter = useShopUi((s) => s.filter);
  const { setSearchOpen, setFilter, openPop } = useShopUi.getState();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 220);
    return () => clearTimeout(t);
  }, [open]);

  const q = fold(query.trim());
  const results = q
    ? products.filter((p) =>
        fold(`${p.name} ${categoryLabel(p.category)} ${p.description} ${p.tags.join(" ")}`).includes(q),
      )
    : [];

  const close = () => setSearchOpen(false);

  const pickCategory = (key: string) => {
    close();
    setTimeout(() => {
      setFilter(key);
      scrollToId("menu");
    }, 300);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click nền để đóng; bàn phím dùng Esc
    <div
      id="searchOv"
      className={open ? "open" : ""}
      role="dialog"
      aria-modal="true"
      aria-label="Tìm món"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <button type="button" className="sovclose" id="searchClose" aria-label="Đóng" onClick={close}>
        <i className="fas fa-times" />
      </button>
      <div className="sovbox">
        <h4>Hôm nay bạn thèm món gì?</h4>
        <form className="sovinput" onSubmit={(e) => e.preventDefault()}>
          <input
            ref={inputRef}
            type="text"
            id="searchInput"
            placeholder="Tìm burger, pizza, gà rán..."
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" aria-label="Tìm">
            <i className="fas fa-search" />
          </button>
        </form>

        {q && (
          <ul className="sovresults">
            {results.length === 0 && <li className="sovempty">Không tìm thấy món phù hợp với “{query.trim()}”.</li>}
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    openPop(p);
                  }}
                >
                  <img src={p.image} alt={p.name} loading="lazy" />
                  <span className="sovrname">{p.name}</span>
                  <span className="sovrprice">{formatVnd(p.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="sovcats">
          {CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.key}
              className={`sovcat${filter === c.key ? " active" : ""}`}
              data-cat={c.key}
              onClick={() => pickCategory(c.key)}
            >
              <img src={`/shop-assets/img/menu/${CAT_IMG[c.key] ?? 1}.jpg`} alt="" loading="lazy" />
              {c.label}
            </button>
          ))}
        </div>
        <div className="sovtrend">
          <p>
            <i className="fas fa-fire me-1" style={{ color: "var(--secondary)" }} />
            Tìm kiếm phổ biến
          </p>
          {TRENDING.map((t) => (
            <button
              type="button"
              className="ttag"
              key={t}
              onClick={() => {
                setQuery(t);
                inputRef.current?.focus();
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
