"use client";

const SOCIALS = ["fab fa-facebook-f", "fab fa-instagram", "fab fa-tiktok", "fab fa-youtube"];

export function Topbar() {
  return (
    <div id="topbar">
      <div className="container">
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div className="top-contact d-flex flex-wrap">
            <span>
              <i className="fas fa-phone-alt" />
              1900 6868
            </span>
            <span>
              <i className="fas fa-envelope" />
              xinchao@sarab.vn
            </span>
            <span>
              <i className="fas fa-map-marker-alt" />
              42 Hàng Bài, Hoàn Kiếm, Hà Nội
            </span>
          </div>
          <div className="d-flex align-items-center gap-3">
            <span className="ttag">
              <i className="fas fa-fire me-1" />
              Miễn phí giao hàng hôm nay!
            </span>
            <div className="tsoc">
              {SOCIALS.map((icon) => (
                <a key={icon} href="#" onClick={(e) => e.preventDefault()}>
                  <i className={icon} />
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
