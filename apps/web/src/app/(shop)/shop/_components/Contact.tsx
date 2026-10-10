"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

const SUBJECTS = ["Hỏi đáp chung", "Đặt tiệc & sự kiện", "Góp ý", "Hợp tác", "Báo chí & truyền thông"];

const EMPTY = { name: "", email: "", phone: "", subject: SUBJECTS[0], message: "" };
type CtcForm = typeof EMPTY;

const SOCIALS = [
  { icon: "fab fa-facebook-f", label: "Facebook" },
  { icon: "fab fa-instagram", label: "Instagram" },
  { icon: "fab fa-twitter", label: "Twitter" },
  { icon: "fab fa-youtube", label: "YouTube" },
];

export function Contact() {
  const [form, setForm] = useState<CtcForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const okRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (done) okRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [done]);

  const set = (k: keyof CtcForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setDone(false);
    timer.current = setTimeout(() => {
      setBusy(false);
      setDone(true);
    }, 1500);
  };

  return (
    <section id="contact-section">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Liên hệ</span>
          <h2 className="stitle">
            Liên hệ <span>với chúng tôi</span>
          </h2>
          <div className="sline" />
          <p className="sdesc mx-auto" style={{ maxWidth: 480 }}>
            Bạn có câu hỏi, góp ý hay muốn tổ chức một sự kiện đặc biệt? Chúng tôi rất muốn được lắng nghe.
          </p>
        </div>
        <div className="row g-4">
          <div className="col-lg-4" data-aos="fade-right">
            <div className="ctdark">
              <h4>Trò chuyện cùng Sarab</h4>
              <p className="ctsub">Chúng tôi thường phản hồi trong vòng 2 giờ trong giờ làm việc.</p>
              <div className="ctitem">
                <div className="cticon">
                  <i className="fas fa-map-marker-alt" />
                </div>
                <div className="ctinfo">
                  <strong>Địa chỉ</strong>
                  <span>
                    123 Nguyễn Huệ, Phường Bến Nghé,
                    <br />
                    Quận 1, TP. Hồ Chí Minh
                  </span>
                </div>
              </div>
              <div className="ctitem">
                <div className="cticon">
                  <i className="fas fa-phone-alt" />
                </div>
                <div className="ctinfo">
                  <strong>Hotline</strong>
                  <span>1900 6868</span>
                </div>
              </div>
              <div className="ctitem">
                <div className="cticon">
                  <i className="fas fa-envelope" />
                </div>
                <div className="ctinfo">
                  <strong>Email</strong>
                  <span>xinchao@sarab.vn</span>
                </div>
              </div>
              <div className="ctitem">
                <div className="cticon">
                  <i className="fas fa-clock" />
                </div>
                <div className="ctinfo">
                  <strong>Giờ làm việc</strong>
                  <span>Thứ 4 - CN: 9:00 - 23:00</span>
                </div>
              </div>
              <div className="ctsocrow">
                {SOCIALS.map((s) => (
                  <a key={s.label} href="#" aria-label={s.label} onClick={(e) => e.preventDefault()}>
                    <i className={s.icon} />
                  </a>
                ))}
              </div>
            </div>
          </div>
          <div className="col-lg-8" data-aos="fade-left">
            <div className="fcard">
              <form onSubmit={onSubmit}>
                <div className="row g-3">
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="ctcName">
                      Họ và tên *
                    </label>
                    <input
                      id="ctcName"
                      type="text"
                      className="fctrl"
                      placeholder="Nguyễn Văn A"
                      required
                      value={form.name}
                      onChange={set("name")}
                    />
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="ctcEmail">
                      Email *
                    </label>
                    <input
                      id="ctcEmail"
                      type="email"
                      className="fctrl"
                      placeholder="ban@email.com"
                      required
                      value={form.email}
                      onChange={set("email")}
                    />
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="ctcPhone">
                      Số điện thoại
                    </label>
                    <input
                      id="ctcPhone"
                      type="tel"
                      className="fctrl"
                      placeholder="0901 234 567"
                      value={form.phone}
                      onChange={set("phone")}
                    />
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="ctcSubject">
                      Chủ đề *
                    </label>
                    <select id="ctcSubject" className="fctrl" value={form.subject} onChange={set("subject")}>
                      {SUBJECTS.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-12">
                    <label className="flbl" htmlFor="ctcMsg">
                      Nội dung *
                    </label>
                    <textarea
                      id="ctcMsg"
                      className="fctrl"
                      rows={5}
                      placeholder="Viết lời nhắn của bạn tại đây..."
                      required
                      value={form.message}
                      onChange={set("message")}
                    />
                  </div>
                  <div className="col-12">
                    <button type="submit" className="btn-red" id="ctcBtn" disabled={busy}>
                      {busy ? (
                        <>
                          <i className="fas fa-spinner fa-spin" /> Đang gửi...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-paper-plane" />
                          Gửi tin nhắn
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
              <div className="sucmsg" id="ctcOk" ref={okRef} style={done ? { display: "block" } : undefined}>
                <i className="fas fa-check-circle" />
                <p>Đã gửi tin nhắn! Chúng tôi sẽ phản hồi trong vòng 2 giờ.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
