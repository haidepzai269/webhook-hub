"use client";

import { useEffect, useRef, useState } from "react";

export function Newsletter() {
  const [email, setEmail] = useState("");
  const [subscribed, setSubscribed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const subscribe = () => {
    if (!email.includes("@")) return;
    setSubscribed(true);
    setEmail("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSubscribed(false), 3000);
  };

  return (
    <section id="newsletter">
      <div className="nlbg" />
      <div className="container">
        <div className="nlw text-center" data-aos="zoom-in">
          <span className="slbl" style={{ color: "rgba(255,255,255,.7)" }}>
            Luôn kết nối
          </span>
          <h2 className="mb-3" style={{ color: "#fff" }}>
            Đăng ký & nhận <span style={{ color: "var(--secondary)" }}>ưu đãi độc quyền</span>
          </h2>
          <p className="mb-4" style={{ color: "rgba(255,255,255,.78)" }}>
            Giảm 15% cho đơn đầu tiên và được thử món mới sớm nhất
          </p>
          <div className="nl-form-wrap">
            <input
              className="nlinput"
              type="email"
              id="nlEmail"
              placeholder="Nhập địa chỉ email của bạn..."
              aria-label="Email đăng ký nhận tin"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") subscribe();
              }}
            />
            <button
              type="button"
              className="nlbtn"
              id="nlBtn"
              onClick={subscribe}
              style={subscribed ? { background: "#4ade80", color: "#222" } : undefined}
            >
              {subscribed ? (
                "✓ Đã đăng ký!"
              ) : (
                <>
                  <i className="fas fa-paper-plane me-1" />
                  Đăng ký
                </>
              )}
            </button>
          </div>
          <p style={{ color: "rgba(255,255,255,.45)", fontSize: ".76rem", marginTop: 11 }}>
            <i className="fas fa-lock me-1" />
            Không spam, huỷ đăng ký bất cứ lúc nào.
          </p>
        </div>
      </div>
    </section>
  );
}
