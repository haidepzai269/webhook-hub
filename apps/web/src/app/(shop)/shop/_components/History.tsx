const ITEMS = [
  {
    year: "2014",
    title: "Những ngày đầu",
    text: "Sarab mở quán đầu tiên chỉ 20 chỗ ngồi trên phố Hàng Bài. Chỉ sau 3 tháng, khách xếp hàng dài mỗi tối khi tiếng lành về món ăn lan xa.",
  },
  {
    year: "2017",
    title: "Định hình phong cách",
    text: "Mở rộng tầm nhìn — chúng tôi ra mắt thực đơn nếm thử đặc trưng và đón bếp trưởng đầu tiên được đào tạo bài bản, nâng tay nghề lên tầm cao mới.",
  },
  {
    year: "2021",
    title: "Dòng đồ ăn nhanh hiện đại",
    text: "Ra mắt dòng đồ ăn nhanh đặc trưng, kết hợp chất lượng cao cấp với tốc độ và sự tiện lợi. Chỉ trong 6 tháng đã nhận 3 giải thưởng ẩm thực uy tín.",
  },
  {
    year: "2026",
    title: "Vươn ra toàn quốc",
    text: "Hiện có mặt tại 8 tỉnh thành với nền tảng giao hàng trực tuyến xử lý hơn 10.000 đơn mỗi tuần — và vẫn đang tiếp tục phát triển.",
  },
];

export function History() {
  return (
    <section id="history">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Hành trình của chúng tôi</span>
          <h2 className="stitle">
            Lịch sử <span>nhà hàng</span>
          </h2>
          <div className="sline" />
          <p className="sdesc mx-auto" style={{ maxWidth: "480px" }}>
            Từ khởi đầu khiêm tốn đến nhà hàng được yêu thích nhất thành phố — mỗi chương đều được viết bằng đam mê.
          </p>
        </div>
        <div className="timeline" data-aos="fade-up">
          {ITEMS.map((it) => (
            <div key={it.year} className="tli">
              <div className="tl-left">
                <div className="tlyear">{it.year}</div>
                <h5>{it.title}</h5>
                <p>{it.text}</p>
              </div>
              <div className="tl-center">
                <div className="tldot" />
              </div>
              <div className="tl-right">
                <div className="tlyear">{it.year}</div>
                <h5>{it.title}</h5>
                <p>{it.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
