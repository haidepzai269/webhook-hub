"use client";

import type { MouseEvent } from "react";

import { scrollToId } from "@/lib/shop/ui";

const SOCIALS = [
  { icon: "fab fa-facebook-f", label: "Facebook" },
  { icon: "fab fa-instagram", label: "Instagram" },
  { icon: "fab fa-twitter", label: "Twitter" },
  { icon: "fab fa-youtube", label: "YouTube" },
  { icon: "fab fa-tiktok", label: "TikTok" },
];

const QUICK_LINKS = [
  { id: "hero", label: "Trang chủ" },
  { id: "about", label: "Về chúng tôi" },
  { id: "menu", label: "Thực đơn" },
  { id: "reservation", label: "Đặt bàn" },
  { id: "blog", label: "Tin tức" },
  { id: "contact-section", label: "Liên hệ" },
];

const MENU_LINKS = ["Burger", "Pizza", "Gà rán", "Wrap & cuốn", "Mì Ý", "Tráng miệng"];

const CONTACT = [
  { icon: "fas fa-map-marker-alt", label: "Địa chỉ", value: "123 Nguyễn Huệ, Q.1, TP.HCM" },
  { icon: "fas fa-phone-alt", label: "Hotline", value: "1900 6868" },
  { icon: "fas fa-envelope", label: "Email", value: "xinchao@sarab.vn" },
  { icon: "fas fa-clock", label: "Giờ mở cửa", value: "Thứ 4 - CN: 09:00 - 23:00" },
];

const noNav = (e: MouseEvent<HTMLAnchorElement>) => e.preventDefault();
const goTo = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
  e.preventDefault();
  scrollToId(id);
};

export function Footer() {
  return (
    <footer>
      <div className="container">
        <div className="row g-5">
          <div className="col-lg-4">
            <div className="fnm">
              Sar<span>ab</span>
            </div>
            <p className="fdesc">
              Chúng tôi mang hương vị ngon nhất thế giới đến với bạn — nhanh, thân thiện và vừa túi tiền. Mỗi bữa ăn đều
              được làm bằng cả tấm lòng.
            </p>
            <div className="fsoc">
              {SOCIALS.map((s) => (
                <a key={s.label} href="#" aria-label={s.label} onClick={noNav}>
                  <i className={s.icon} />
                </a>
              ))}
            </div>
          </div>
          <div className="col-sm-6 col-lg-2">
            <div className="ftit">Liên kết nhanh</div>
            <ul className="flinks ps-0">
              {QUICK_LINKS.map((l) => (
                <li key={l.id}>
                  <a href={`#${l.id}`} onClick={goTo(l.id)}>
                    <i className="fas fa-chevron-right" />
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="col-sm-6 col-lg-2">
            <div className="ftit">Thực đơn</div>
            <ul className="flinks ps-0">
              {MENU_LINKS.map((m) => (
                <li key={m}>
                  <a href="#menu" onClick={goTo("menu")}>
                    <i className="fas fa-chevron-right" />
                    {m}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="col-lg-4">
            <div className="ftit">Liên hệ</div>
            {CONTACT.map((c) => (
              <div key={c.label} className="fci">
                <div className="fciico">
                  <i className={c.icon} />
                </div>
                <div className="fciinfo">
                  <strong>{c.label}</strong>
                  {c.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="fbot">
        <div className="container">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <p>
              © 2026 <span>Sarab Restaurant</span>. Thiết kế bởi{" "}
              <a
                target="_blank"
                rel="noopener noreferrer"
                className="mx-0 fw-bold text-success"
                href="https://bestwpware.com/"
              >
                Bestwpware
              </a>
              . Làm bằng cả{" "}
              <span>
                <i className="fas fa-heart" />
              </span>
              <br />
              Phân phối bởi{" "}
              <a
                target="_blank"
                rel="noopener noreferrer"
                className="mx-0 fw-bold text-success"
                href="https://themewagon.com"
              >
                ThemeWagon
              </a>{" "}
              (MIT)
            </p>
            <div>
              <a href="#" onClick={noNav}>
                Chính sách bảo mật
              </a>
              <a href="#" onClick={noNav}>
                Điều khoản
              </a>
              <a href="#" onClick={noNav}>
                Cookie
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
