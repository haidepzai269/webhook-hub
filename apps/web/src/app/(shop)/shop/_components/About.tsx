"use client";

import { scrollToId } from "@/lib/shop/ui";

const FEATURES = [
  {
    tone: "r",
    icon: "fas fa-leaf",
    title: "Nguyên liệu tươi 100%",
    text: "Nguyên liệu được chọn lọc thủ công mỗi ngày từ các nhà cung cấp địa phương để luôn tươi ngon nhất.",
  },
  {
    tone: "y",
    icon: "fas fa-award",
    title: "Công thức đạt giải thưởng",
    text: "Các công thức đặc trưng của chúng tôi đã đạt giải ẩm thực toàn quốc 5 năm liên tiếp.",
  },
  {
    tone: "g",
    icon: "fas fa-shipping-fast",
    title: "Giao hàng siêu tốc",
    text: "Đặt món trực tuyến và nhận đồ ăn nóng hổi tận cửa trong vòng 25 phút.",
  },
];

export function About() {
  return (
    <section id="about">
      <div className="container">
        <div className="row align-items-center g-5">
          <div className="col-lg-5" data-aos="fade-right">
            <div className="astack">
              <div className="aexp">
                <span className="anum">12+</span>
                <small>
                  Năm
                  <br />
                  phục vụ
                </small>
              </div>
              <div className="amain">
                <img src="/shop-assets/img/about1.jpg" alt="Không gian nhà hàng Sarab" loading="lazy" />
              </div>
              <div className="asm">
                <img src="/shop-assets/img/about2.jpg" alt="Món ăn tại Sarab" loading="lazy" />
              </div>
            </div>
          </div>
          <div className="col-lg-7" data-aos="fade-left">
            <span className="slbl">Câu chuyện của chúng tôi</span>
            <h2 className="stitle text-start">
              Mời bạn ghé thăm
              <br />
              <span>nhà hàng Sarab</span>
            </h2>
            <div className="sline lft" />
            <p className="sdesc mb-4">
              Thành lập năm 2014, Sarab khởi đầu là một quán nhỏ ở góc phố với ước mơ lớn — phục vụ những món ăn gắn kết
              mọi người. Hôm nay, chúng tôi tự hào phục vụ hàng nghìn thực khách mỗi tuần với cùng niềm đam mê thuở ban
              đầu.
            </p>
            <div className="mb-4">
              {FEATURES.map((f) => (
                <div key={f.title} className="fti">
                  <div className={`ftico ${f.tone}`}>
                    <i className={f.icon} />
                  </div>
                  <div>
                    <h6>{f.title}</h6>
                    <p>{f.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <a
              href="#menu"
              className="btn-red"
              onClick={(e) => {
                e.preventDefault();
                scrollToId("menu");
              }}
            >
              <i className="fas fa-book-open" />
              Xem toàn bộ thực đơn
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
