"use client";

import { useEffect, useState } from "react";

import { scrollToId } from "@/lib/shop/ui";

// Đồng hồ đếm ngược thuần trang trí (main.js gốc): bắt đầu 08:45:30, hết thì quay vòng. Không có logic giảm giá thật.
const START = 8 * 3600 + 45 * 60 + 30;
const pad = (n: number) => String(n).padStart(2, "0");

export function Special() {
  const [left, setLeft] = useState(START);

  useEffect(() => {
    const iv = setInterval(() => setLeft((s) => (s <= 0 ? START : s - 1)), 1000);
    return () => clearInterval(iv);
  }, []);

  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;

  return (
    <section id="special">
      <div className="spbg" />
      <div className="container" style={{ position: "relative", zIndex: 2 }}>
        <div className="row align-items-center g-5">
          <div className="col-lg-6" data-aos="fade-right">
            <div className="sptag">
              <i className="fas fa-bolt me-1" />
              Ưu đãi có hạn
            </div>
            <h2 className="sptitle">
              Giảm 30%
              <br />
              combo
              <br />
              <span>Burger</span> đặc biệt
            </h2>
            <p className="spdesc">
              Đừng bỏ lỡ ưu đãi cuối tuần — combo burger đặc trưng từng đoạt giải kèm khoai tây chiên phô mai và sữa lắc
              thượng hạng với mức giá không thể tốt hơn.
            </p>
            <div className="cdwrap">
              <div className="cditem">
                <span className="cdnum" id="cdH">
                  {pad(h)}
                </span>
                <span className="cdlbl">Giờ</span>
              </div>
              <div className="cditem">
                <span className="cdnum" id="cdM">
                  {pad(m)}
                </span>
                <span className="cdlbl">Phút</span>
              </div>
              <div className="cditem">
                <span className="cdnum" id="cdS">
                  {pad(s)}
                </span>
                <span className="cdlbl">Giây</span>
              </div>
            </div>
            <a
              href="#menu"
              className="btn-red"
              onClick={(e) => {
                e.preventDefault();
                scrollToId("menu");
              }}
            >
              <i className="fas fa-shopping-cart" />
              Săn ưu đãi ngay
            </a>
          </div>
          <div className="col-lg-6" data-aos="fade-left">
            <div className="spimgw">
              <div className="spglow" />
              <div className="sppbdg">
                <span className="old">199.000đ</span>
                <span className="np">139.000đ</span>
              </div>
              <img src="/shop-assets/img/off-img.jpg" alt="Combo burger đặc biệt" loading="lazy" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
