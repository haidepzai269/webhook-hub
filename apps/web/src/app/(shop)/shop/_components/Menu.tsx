"use client";

import { useEffect, useState } from "react";

import { fetchProducts, formatVnd, type Product } from "@/lib/shop/api";
import { useCart } from "@/lib/shop/cart";
import { CATEGORIES, categoryLabel, useShopUi } from "@/lib/shop/ui";

// Số liệu trình bày (kcal, phút chuẩn bị, lượt đánh giá) — chỉ để hiển thị như template, không có backend.
export const DISPLAY_META: Record<string, { cal: number; time: number; reviews: number }> = {
  m1: { cal: 620, time: 12, reviews: 128 },
  m2: { cal: 840, time: 18, reviews: 96 },
  m3: { cal: 710, time: 15, reviews: 143 },
  m4: { cal: 480, time: 10, reviews: 74 },
  m5: { cal: 390, time: 8, reviews: 112 },
  m6: { cal: 560, time: 16, reviews: 88 },
};

export function Menu() {
  const products = useShopUi((s) => s.products);
  const error = useShopUi((s) => s.productsError);
  const filter = useShopUi((s) => s.filter);
  const { setFilter, openPop, setProducts, setProductsError } = useShopUi.getState();
  const [loading, setLoading] = useState(true);
  const [liked, setLiked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    fetchProducts()
      .then((p) => alive && setProducts(p))
      .catch((e: Error) => alive && setProductsError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [setProducts, setProductsError]);

  const visible = products.filter((p) => filter === "all" || p.category === filter);

  return (
    <section id="menu">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Bếp đang nấu gì</span>
          <h2 className="stitle">
            Thực đơn <span>Hấp dẫn</span>
          </h2>
          <div className="sline" />
        </div>
        <div className="text-center mb-4" data-aos="fade-up">
          {CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.key}
              className={`filtbtn${filter === c.key ? " active" : ""}`}
              data-f={c.key}
              onClick={() => setFilter(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="row g-4" id="mgrid">
          {loading && <p className="text-center text-muted">Đang tải thực đơn…</p>}
          {error && (
            <p className="text-center" style={{ color: "var(--primary)" }}>
              Không tải được thực đơn: {error}
            </p>
          )}
          {!loading && !error && visible.length === 0 && (
            <p className="text-center text-muted">Danh mục này đang tạm hết món.</p>
          )}
          {visible.map((p, i) => (
            <MenuCard
              key={p.id}
              product={p}
              delay={(i % 3) * 80}
              liked={!!liked[p.id]}
              onLike={() => setLiked((s) => ({ ...s, [p.id]: !s[p.id] }))}
              onOpen={() => openPop(p)}
            />
          ))}
        </div>
        <div className="text-center mt-5">
          <button type="button" className="btn-red" onClick={() => setFilter("all")}>
            <i className="fas fa-th-large" />
            Xem toàn bộ thực đơn
          </button>
        </div>
      </div>
    </section>
  );
}

function MenuCard(props: { product: Product; delay: number; liked: boolean; onLike: () => void; onOpen: () => void }) {
  const { product: p, delay, liked, onLike, onOpen } = props;
  const meta = DISPLAY_META[p.id];
  const badge = p.tags[0];
  const add = useCart((s) => s.add);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(false), 900);
    return () => clearTimeout(t);
  }, [added]);
  return (
    <div className="col-sm-6 col-lg-4 mwrap" data-c={p.category} data-aos="fade-up" data-aos-delay={delay || undefined}>
      {/* biome-ignore lint/a11y/useSemanticElements: giữ markup .mcard gốc của Sarab */}
      <div
        className="mcard"
        role="button"
        tabIndex={0}
        aria-label={`Xem chi tiết ${p.name}`}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="mimg">
          <img src={p.image} alt={p.name} loading="lazy" />
          {badge && (
            <div className="mbdg hot">
              <i className="fas fa-star" /> {badge}
            </div>
          )}
          <button
            type="button"
            className="mhrt"
            aria-label={liked ? "Bỏ thích" : "Yêu thích"}
            style={{ color: liked ? "var(--primary)" : "#ccc" }}
            onClick={(e) => {
              e.stopPropagation();
              onLike();
            }}
          >
            <i className={`${liked ? "fas" : "far"} fa-heart`} />
          </button>
        </div>
        <div className="mbody">
          <div className="mcat">{categoryLabel(p.category)}</div>
          <div className="mtit">{p.name}</div>
          <div className="mdesc">{p.description}</div>
          <div className="mfoot">
            <div>
              <div className="mprice">
                {formatVnd(p.price)} {p.oldPrice > p.price && <small>{formatVnd(p.oldPrice)}</small>}
              </div>
              <div className="mstars">
                <i className="fas fa-star" />{" "}
                <span style={{ color: "#bbb", fontSize: ".7rem" }}>({meta?.reviews ?? 0})</span>
              </div>
            </div>
            <button
              type="button"
              className="madd"
              title="Thêm 1 phần vào giỏ"
              aria-label={`Thêm 1 phần ${p.name} vào giỏ`}
              style={added ? { background: "var(--green)" } : undefined}
              onClick={(e) => {
                e.stopPropagation();
                add(p.id, 1);
                setAdded(true);
              }}
            >
              <i className={`fas ${added ? "fa-check" : "fa-plus"}`} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
