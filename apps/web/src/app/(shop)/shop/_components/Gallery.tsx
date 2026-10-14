"use client";

import { useEffect, useState } from "react";

import { bodyScrollLock } from "@/lib/ui/scroll-lock";

interface GalleryItem {
  img: string;
  title: string;
  desc: string;
  alt: string;
}

const GALLERY: GalleryItem[] = [
  {
    img: "/shop-assets/img/portfolio/work1.jpg",
    title: "Burger thượng hạng",
    desc: "Smash burger đạt giải của chúng tôi, làm thủ công từ 100% bò cao cấp, phô mai cheddar ủ lâu năm và sốt nhà làm.",
    alt: "Burger bò phô mai",
  },
  {
    img: "/shop-assets/img/portfolio/work2.jpg",
    title: "Pizza nướng lò củi",
    desc: "Pizza chuẩn vị Napoli, nướng ở gần 480°C trong lò đá đốt củi cho lớp vỏ cháy cạnh hoàn hảo.",
    alt: "Pizza nướng lò củi",
  },
  {
    img: "/shop-assets/img/portfolio/work3.jpg",
    title: "Gà rán giòn rụm",
    desc: "Gà ướp muối hai lần, tẩm bột bằng tay và chiên vàng giòn với công thức bí mật 15 loại gia vị.",
    alt: "Gà rán giòn",
  },
  {
    img: "/shop-assets/img/portfolio/work4.jpg",
    title: "Tráng miệng ngọt ngào",
    desc: "Món tráng miệng làm thủ công — từ bánh lava socola tan chảy đến kem sundae và bánh ngọt theo mùa.",
    alt: "Món tráng miệng",
  },
  {
    img: "/shop-assets/img/portfolio/work5.jpg",
    title: "Wrap & cuốn tươi",
    desc: "Bánh cuốn wrap đầy ắp thịt nướng, rau củ giòn tươi và sốt nhà làm đặc trưng.",
    alt: "Bánh wrap cuốn tươi",
  },
];

export function Gallery() {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const item = GALLERY[idx];

  const close = () => setOpen(false);
  const prev = () => setIdx((i) => (i - 1 + GALLERY.length) % GALLERY.length);
  const next = () => setIdx((i) => (i + 1) % GALLERY.length);

  useEffect(() => {
    if (!open) return;
    bodyScrollLock.lock();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      bodyScrollLock.unlock();
    };
  }, [open]);

  return (
    <>
      <section id="gallery">
        <div className="container">
          <div className="text-center mb-5" data-aos="fade-up">
            <span className="slbl">Góc món ngon</span>
            <h2 className="stitle">
              Ngắm nhìn <span>món ngon</span> của chúng tôi
            </h2>
            <div className="sline" />
          </div>
          <div className="ggrid" data-aos="fade-up">
            {GALLERY.map((g, i) => (
              <div
                key={g.img}
                className="gitem"
                data-gi={i}
                role="button"
                tabIndex={0}
                aria-label={`Xem ảnh ${g.title}`}
                onClick={() => {
                  setIdx(i);
                  setOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setIdx(i);
                    setOpen(true);
                  }
                }}
              >
                <img src={g.img} alt={g.alt} loading="lazy" />
                <div className="gover">
                  <span>
                    <i className="fas fa-expand-alt" /> {g.title}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click nền để đóng; bàn phím dùng Esc */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc đã xử lý ở effect */}
      <div
        id="galPop"
        className={open ? "open" : undefined}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="gpbox">
          <button type="button" className="gpclose" id="gpClose" aria-label="Đóng" onClick={close}>
            <i className="fas fa-times" />
          </button>
          <img id="gpImg" src={item.img} alt={item.alt} loading="lazy" />
          <div className="gpcap">
            <h5 id="gpTitle">{item.title}</h5>
            <p id="gpDesc">{item.desc}</p>
          </div>
          <div className="gpnav">
            <button type="button" id="gpPrev" onClick={prev}>
              <i className="fas fa-chevron-left me-1" />
              Trước
            </button>
            <button type="button" id="gpNext" onClick={next}>
              Tiếp <i className="fas fa-chevron-right ms-1" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
