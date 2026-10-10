"use client";

import { Autoplay, Pagination } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css";
import "swiper/css/pagination";

interface Testimonial {
  text: string;
  img: string;
  name: string;
  role: string;
}

const TESTIMONIALS: Testimonial[] = [
  {
    text: "Thật lòng mà nói đây là burger ngon nhất mình từng ăn. Smash burger xuất sắc — viền giòn rụm, bên trong mọng nước, dưa chua thì khỏi chê! Giờ tối thứ Sáu nào cả nhà cũng ghé.",
    img: "/shop-assets/img/testimonial/1.jpg",
    name: "Nguyễn Thu Hà",
    role: "Khách quen",
  },
  {
    text: "Đặt giao tận nơi mà 22 phút đã có, đồ ăn vẫn nóng hổi. Phần ăn rất đầy đặn. Sarab chắc chắn là chỗ mình chọn mỗi khi thèm đồ ăn nhanh.",
    img: "/shop-assets/img/testimonial/2.jpg",
    name: "Trần Minh Khoa",
    role: "Food blogger",
  },
  {
    text: "Mì Ý sốt nấm truffle làm mình bất ngờ thật sự. Không nghĩ quán đồ ăn nhanh lại có chất lượng như vậy. Không gian dễ chịu, nhân viên cực kỳ thân thiện. Rất đáng thử!",
    img: "/shop-assets/img/testimonial/3.jpg",
    name: "Lê Ngọc Anh",
    role: "Người mê ẩm thực",
  },
  {
    text: "Đặt tiệc cho buổi liên hoan công ty 50 người, mọi thứ đều hoàn hảo: tươi, ngon, đúng giờ và trình bày đẹp. Gà cay Nashville là ngôi sao của bữa tiệc!",
    img: "/shop-assets/img/testimonial/4.jpg",
    name: "Phạm Quốc Bảo",
    role: "Khách hàng doanh nghiệp",
  },
];

export function Testimonials() {
  return (
    <section id="testimonials">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Khách hàng nói gì</span>
          <h2 className="stitle">
            Cảm nhận của <span>thực khách</span>
          </h2>
          <div className="sline" />
        </div>
        <Swiper
          className="tesSwiper"
          data-aos="fade-up"
          modules={[Autoplay, Pagination]}
          slidesPerView={1}
          spaceBetween={22}
          loop
          autoplay={{ delay: 4000, disableOnInteraction: false }}
          // Giữ phần tử .swiper-pagination gốc (mt-4 + position:static) để chấm không đè lên thẻ.
          pagination={{ el: ".tesSwiper .swiper-pagination", clickable: true }}
          breakpoints={{ 640: { slidesPerView: 2 }, 1024: { slidesPerView: 3 } }}
        >
          {TESTIMONIALS.map((t) => (
            <SwiperSlide key={t.name}>
              <div className="tescard">
                <div className="tesq">&quot;</div>
                <div className="tess">
                  {[0, 1, 2, 3, 4].map((s) => (
                    <i key={s} className="fas fa-star" />
                  ))}
                </div>
                <p className="testxt">{t.text}</p>
                <div className="tesauth">
                  <img src={t.img} alt={`Ảnh khách hàng ${t.name}`} loading="lazy" />
                  <div>
                    <div className="tesnm">{t.name}</div>
                    <div className="tesrl">{t.role}</div>
                  </div>
                </div>
              </div>
            </SwiperSlide>
          ))}
          <div slot="container-end" className="swiper-pagination mt-4" style={{ position: "static" }} />
        </Swiper>
      </div>
    </section>
  );
}
