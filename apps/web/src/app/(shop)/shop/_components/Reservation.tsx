"use client";

import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";

import { ShopDatePicker } from "./ShopDatePicker";

const iconBox: CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: 11,
  background: "rgba(232,40,26,.2)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--primary)",
  fontSize: "1.1rem",
  flexShrink: 0,
};
const infoLbl: CSSProperties = {
  display: "block",
  color: "#ccc",
  fontSize: ".78rem",
  textTransform: "uppercase",
  letterSpacing: ".8px",
};
const infoVal: CSSProperties = { color: "#fff", fontSize: ".87rem" };

const INFO = [
  { icon: "fas fa-clock", label: "Giờ mở cửa", value: "Thứ 4 - CN, 9:00 - 23:00" },
  { icon: "fas fa-phone-alt", label: "Gọi đặt bàn", value: "1900 6868" },
  { icon: "fas fa-users", label: "Đặt tiệc nhóm", value: "Thực đơn riêng cho nhóm từ 10 người" },
  { icon: "fas fa-map-marker-alt", label: "Địa chỉ", value: "123 Nguyễn Huệ, Q.1, TP.HCM" },
];

const GUESTS = ["1 người", "2 người", "3 - 4 người", "5 - 6 người", "7 - 10 người", "Trên 10 người"];
const TIMES = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "18:00", "19:00", "20:00", "21:00", "22:00"];

const EMPTY = { name: "", phone: "", email: "", guests: GUESTS[1], date: "", time: TIMES[0], note: "" };
type ResForm = typeof EMPTY;

export function Reservation() {
  const [form, setForm] = useState<ResForm>(EMPTY);
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

  const set = (k: keyof ResForm) => (e: { target: { value: string } }) =>
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
    <section id="reservation">
      <div className="container">
        <div className="text-center mb-5" data-aos="fade-up">
          <span className="slbl">Đặt bàn</span>
          <h2 className="stitle">
            Đặt <span>bàn trước</span>
          </h2>
          <div className="sline" />
          <p className="sdesc mx-auto" style={{ maxWidth: 480 }}>
            Giữ chỗ cho một bữa ăn đáng nhớ. Cuối tuần đông khách, bạn nên đặt trước 24 giờ nhé.
          </p>
        </div>
        <div className="row g-4 align-items-start">
          <div className="col-lg-4" data-aos="fade-right">
            <div style={{ background: "var(--dark)", borderRadius: 18, padding: 36 }}>
              <h4 style={{ color: "#fff", fontSize: "1.3rem", marginBottom: 8 }}>Thông tin liên hệ</h4>
              <p style={{ color: "rgba(255,255,255,.55)", fontSize: ".85rem", marginBottom: 26 }}>
                Chúng tôi luôn sẵn lòng giúp bạn chuẩn bị một bữa ăn trọn vẹn.
              </p>
              <div className="d-flex flex-column gap-3">
                {INFO.map((it) => (
                  <div key={it.label} className="d-flex align-items-center gap-3">
                    <div style={iconBox}>
                      <i className={it.icon} />
                    </div>
                    <div>
                      <strong style={infoLbl}>{it.label}</strong>
                      <span style={infoVal}>{it.value}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="col-lg-8" data-aos="fade-left">
            <div className="fcard">
              <form onSubmit={onSubmit}>
                <div className="row g-3">
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="resName">
                      Họ và tên *
                    </label>
                    <input
                      id="resName"
                      type="text"
                      className="fctrl"
                      placeholder="Nguyễn Văn A"
                      required
                      value={form.name}
                      onChange={set("name")}
                    />
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="resPhone">
                      Số điện thoại *
                    </label>
                    <input
                      id="resPhone"
                      type="tel"
                      className="fctrl"
                      placeholder="0901 234 567"
                      required
                      value={form.phone}
                      onChange={set("phone")}
                    />
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="resEmail">
                      Email *
                    </label>
                    <input
                      id="resEmail"
                      type="email"
                      className="fctrl"
                      placeholder="ban@email.com"
                      required
                      value={form.email}
                      onChange={set("email")}
                    />
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="resGuests">
                      Số khách *
                    </label>
                    <select id="resGuests" className="fctrl" value={form.guests} onChange={set("guests")}>
                      {GUESTS.map((g) => (
                        <option key={g}>{g}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="resDate">
                      Ngày *
                    </label>
                    <ShopDatePicker
                      id="resDate"
                      required
                      value={form.date}
                      onChange={(date) => setForm((f) => ({ ...f, date }))}
                    />
                  </div>
                  <div className="col-sm-6">
                    <label className="flbl" htmlFor="resTime">
                      Giờ *
                    </label>
                    <select id="resTime" className="fctrl" value={form.time} onChange={set("time")}>
                      {TIMES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-12">
                    <label className="flbl" htmlFor="resNote">
                      Yêu cầu đặc biệt
                    </label>
                    <textarea
                      id="resNote"
                      className="fctrl"
                      rows={3}
                      placeholder="Dị ứng, chế độ ăn, dịp đặc biệt..."
                      value={form.note}
                      onChange={set("note")}
                    />
                  </div>
                  <div className="col-12">
                    <button type="submit" className="btn-red w-100 justify-content-center" id="resBtn" disabled={busy}>
                      {busy ? (
                        <>
                          <i className="fas fa-spinner fa-spin" /> Đang đặt bàn...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-calendar-check" />
                          Xác nhận đặt bàn
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
              <div className="sucmsg" id="resOk" ref={okRef} style={done ? { display: "block" } : undefined}>
                <i className="fas fa-check-circle" />
                <p>Đặt bàn thành công! Chúng tôi sẽ sớm gửi email xác nhận.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
