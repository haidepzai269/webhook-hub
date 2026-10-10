"use client";

import { scrollToId } from "@/lib/shop/ui";

const ACCENT = { color: "var(--secondary)" } as const;
const SMALL = { fontSize: ".8rem" } as const;

const HOURS = [
  { day: "Thứ Hai - Thứ Ba", time: "Nghỉ", open: false },
  { day: "Thứ Tư - Thứ Năm", time: "09:00 - 22:00", open: true },
  { day: "Thứ Sáu", time: "09:00 - 23:00", open: true },
  { day: "Thứ Bảy", time: "10:00 - 23:30", open: true },
  { day: "Chủ Nhật", time: "11:00 - 21:00", open: true },
];

const CONTACT = [
  { icon: "fas fa-location-dot me-2", label: "Địa chỉ", value: "42 Hàng Bài, Hoàn Kiếm, Hà Nội" },
  { icon: "fas fa-phone me-2", label: "Điện thoại", value: "1900 6868" },
  { icon: "fas fa-envelope me-2", label: "Email", value: "xinchao@sarab.vn" },
];

export function Hours() {
  return (
    <section id="hours">
      <div className="hrsbg" />
      <div className="container" style={{ position: "relative", zIndex: 2 }}>
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl" style={{ color: "#a5d6bc" }}>
            Giờ mở cửa
          </span>
          <h2 className="stitle" style={{ color: "#fff" }}>
            Luôn sẵn sàng <span style={ACCENT}>phục vụ bạn</span>
          </h2>
          <div className="sline" />
        </div>
        <div className="row g-4 align-items-start">
          <div className="col-lg-5" data-aos="fade-right">
            <div className="hrscard">
              {HOURS.map((h) => (
                <div key={h.day} className="hrsrow">
                  <span className="hrsday">
                    <i className="fas fa-calendar-day me-2" style={ACCENT} />
                    {h.day}
                  </span>
                  <div className="d-flex align-items-center gap-2">
                    <div className={h.open ? "hdot on" : "hdot off"} />
                    <span className="hrstime" style={h.open ? undefined : { color: "#ff6b6b" }}>
                      {h.time}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="col-lg-3" data-aos="zoom-in">
            <div className="hrscta">
              <i className="fas fa-truck-fast fa-2x mb-3" style={{ color: "rgba(255,255,255,.8)" }} />
              <h4>Đặt món online</h4>
              <p>Đồ ăn nóng hổi giao tận nơi trong 25 phút</p>
              <a
                href="#menu"
                className="btnw"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToId("menu");
                }}
              >
                Đặt ngay →
              </a>
            </div>
          </div>
          <div className="col-lg-4" data-aos="fade-left">
            <div className="hrscard">
              <h5
                style={{
                  color: "#fff",
                  marginBottom: "18px",
                  fontFamily: "'Poppins',sans-serif",
                  fontSize: ".95rem",
                  fontWeight: 700,
                }}
              >
                <i className="fas fa-map-marker-alt me-2" style={ACCENT} />
                Tìm chúng tôi
              </h5>
              {CONTACT.map((c) => (
                <div key={c.label} className="hrsrow">
                  <span className="hrsday">
                    <i className={c.icon} style={ACCENT} />
                    {c.label}
                  </span>
                  <span className="hrstime" style={SMALL}>
                    {c.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
