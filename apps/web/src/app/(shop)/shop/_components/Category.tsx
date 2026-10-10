"use client";

import { categoryLabel, scrollToId, useShopUi } from "@/lib/shop/ui";

// Giữ thứ tự + ảnh của template: thẻ đầu là "Tất cả". Số món đếm từ menu thật (GET /products).
const CARDS = [
  { key: "all", img: 1, delay: 0 },
  { key: "burgers", img: 2, delay: 70 },
  { key: "pizza", img: 3, delay: 140 },
  { key: "chicken", img: 4, delay: 210 },
  { key: "wraps", img: 5, delay: 280 },
  { key: "desserts", img: 6, delay: 350 },
];

export function Category() {
  const filter = useShopUi((s) => s.filter);
  const products = useShopUi((s) => s.products);
  const countOf = (key: string) =>
    key === "all" ? products.length : products.filter((p) => p.category === key).length;

  const pick = (f: string) => {
    scrollToId("menu");
    setTimeout(() => useShopUi.getState().setFilter(f), 480);
  };

  return (
    <section id="category">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Chúng tôi phục vụ</span>
          <h2 className="stitle">
            Chọn theo <span>danh mục</span>
          </h2>
          <div className="sline" />
          <p className="sdesc mx-auto" style={{ maxWidth: "480px" }}>
            Từ burger nóng hổi đến pizza, gà rán và tráng miệng — tìm ngay món bạn yêu thích trong thực đơn
          </p>
        </div>
        <div className="row g-3 justify-content-center">
          {CARDS.map((c) => (
            <div
              key={c.key}
              className="col-6 col-sm-4 col-md-3 col-lg-2"
              data-aos="zoom-in"
              data-aos-delay={String(c.delay)}
            >
              <div
                className={filter === c.key ? "catcard active" : "catcard"}
                data-filter={c.key}
                role="button"
                tabIndex={0}
                onClick={() => pick(c.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick(c.key);
                  }
                }}
              >
                <img
                  className="catimg"
                  src={`/shop-assets/img/category/${c.img}.jpg`}
                  alt={categoryLabel(c.key)}
                  loading="lazy"
                />
                <div className="catnm">{categoryLabel(c.key)}</div>
                <div className="catct">{countOf(c.key)} món</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
