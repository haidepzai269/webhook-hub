"use client";

const CHEFS = [
  { img: 1, name: "Nguyễn Minh Anh", role: "Bếp trưởng", exp: "12 năm kinh nghiệm", delay: 0 },
  { img: 2, name: "Trần Quốc Bảo", role: "Chuyên gia nướng", exp: "8 năm kinh nghiệm", delay: 80 },
  { img: 3, name: "Lê Thu Hà", role: "Bếp bánh ngọt", exp: "10 năm kinh nghiệm", delay: 160 },
  { img: 4, name: "Phạm Đức Long", role: "Nghệ nhân pizza", exp: "9 năm kinh nghiệm", delay: 240 },
];

const SOCIALS = ["fab fa-instagram", "fab fa-facebook-f", "fab fa-twitter"];

export function Chefs() {
  return (
    <section id="chefs">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Đội ngũ bếp</span>
          <h2 className="stitle">
            Gặp gỡ các <span>đầu bếp</span>
          </h2>
          <div className="sline" />
        </div>
        <div className="row g-4">
          {CHEFS.map((c) => (
            <div key={c.img} className="col-sm-6 col-lg-3" data-aos="fade-up" data-aos-delay={String(c.delay)}>
              <div className="chcard">
                <div className="chimg">
                  <img src={`/shop-assets/img/chefs/${c.img}.jpg`} alt={`${c.role} ${c.name}`} loading="lazy" />
                  <div className="chsoc">
                    {SOCIALS.map((icon) => (
                      <a key={icon} href="#" onClick={(e) => e.preventDefault()}>
                        <i className={icon} />
                      </a>
                    ))}
                  </div>
                </div>
                <div className="chbody">
                  <div className="chnm">{c.name}</div>
                  <div className="chrole">{c.role}</div>
                  <div className="chexp">{c.exp}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
