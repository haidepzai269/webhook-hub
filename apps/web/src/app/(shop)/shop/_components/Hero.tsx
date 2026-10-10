"use client";

import { Fragment, useEffect, useState } from "react";

import { scrollToId } from "@/lib/shop/ui";

const STATS = [
  { num: 850, suf: "+", label: "Khách hàng hài lòng" },
  { num: 120, suf: "+", label: "Món trong thực đơn" },
  { num: 15, suf: "+", label: "Đầu bếp giỏi" },
  { num: 12, suf: "năm", label: "Kinh nghiệm" },
];

const TARGETS = STATS.map((s) => s.num);
const STEPS = 55;
const DURATION_MS = 1400;

export function Hero() {
  // Ban đầu hiển thị số cuối (như HTML gốc); khi cuộn qua hero thì đếm lại từ 0 đúng một lần (main.js gốc).
  const [values, setValues] = useState<number[]>(TARGETS);

  useEffect(() => {
    let started = false;
    let iv: ReturnType<typeof setInterval> | undefined;

    const onScroll = () => {
      const hero = document.getElementById("hero");
      if (started || !hero || window.scrollY <= hero.offsetHeight - 300) return;
      started = true;
      window.removeEventListener("scroll", onScroll);
      let current = TARGETS.map(() => 0);
      setValues(current);
      iv = setInterval(() => {
        current = current.map((v, i) => Math.min(TARGETS[i], v + Math.ceil(TARGETS[i] / STEPS)));
        setValues(current);
        if (current.every((v, i) => v >= TARGETS[i])) clearInterval(iv);
      }, DURATION_MS / STEPS);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (iv) clearInterval(iv);
    };
  }, []);

  return (
    <section id="hero">
      <div className="hs hs1" />
      <div className="hs hs2" />
      <div className="hbgtxt">FOOD</div>
      <div className="container">
        <div className="row align-items-center g-5" style={{ minHeight: "88vh" }}>
          <div className="col-lg-6">
            <div className="hbadge">
              <div className="hbi">
                <i className="fas fa-star" />
              </div>
              <span>Nhà hàng đồ ăn nhanh được yêu thích nhất Hà Nội</span>
            </div>
            <h1 className="htitle">
              Món <span className="hl">ăn nhanh</span> ngon
              <br />
              cho mọi khoảnh khắc
            </h1>
            <p className="hdesc">
              Hương vị đậm đà từ nguyên liệu tuyển chọn. Từ burger giòn rụm đến pizza thượng hạng — mỗi miếng ăn là một
              trải nghiệm đáng nhớ.
            </p>
            <div className="d-flex flex-wrap gap-3 mb-2">
              <a
                href="#menu"
                className="btn-red"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToId("menu");
                }}
              >
                <i className="fas fa-utensils" />
                Đặt món ngay
              </a>
              <a
                href="https://www.youtube.com/watch?v=RXv_uIN6e-Y"
                className="magnific_popup btn-play popup-youtube"
                target="_blank"
                rel="noopener noreferrer"
              >
                <div className="pico">
                  <i className="fas fa-play" />
                </div>
                <span>Xem câu chuyện của chúng tôi</span>
              </a>
            </div>
            <div className="hstats d-flex gap-3 flex-wrap mt-4">
              {STATS.map((s, i) => (
                <Fragment key={s.label}>
                  {i > 0 && <div className="sdiv" />}
                  <div className="hstat">
                    <span className="snum">
                      {values[i]}
                      <em>{s.suf}</em>
                    </span>
                    <small>{s.label}</small>
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
          <div className="col-lg-6">
            <div style={{ position: "relative", textAlign: "center" }}>
              <div className="hcircle">
                <img src="/shop-assets/img/banner-img.jpg" alt="Burger bò phô mai" />
              </div>
              <div className="fcard fc1">
                <div className="fcoi r">
                  <i className="fas fa-fire" />
                </div>
                <div>
                  <span className="fcnum">Ưu đãi nóng</span>
                  <span className="fcsm">Giảm 30% hôm nay</span>
                </div>
              </div>
              <div className="fcard fc2">
                <div className="fcoi y">
                  <i className="fas fa-star" />
                </div>
                <div>
                  <span className="fcnum">4.9/5</span>
                  <span className="fcsm">Hơn 2.000 đánh giá</span>
                </div>
              </div>
              <div className="fcard fc3">
                <div className="fcoi g">
                  <i className="fas fa-clock" />
                </div>
                <div>
                  <span className="fcnum">20 phút</span>
                  <span className="fcsm">Giao hàng nhanh</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
