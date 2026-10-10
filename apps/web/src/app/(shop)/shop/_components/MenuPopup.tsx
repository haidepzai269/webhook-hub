"use client";

import { useEffect, useState } from "react";

import { formatVnd, type Product } from "@/lib/shop/api";
import { MAX_QTY, useCart } from "@/lib/shop/cart";
import { categoryLabel, useShopUi } from "@/lib/shop/ui";

import { DISPLAY_META } from "./Menu";

export function MenuPopup() {
  const item = useShopUi((s) => s.popItem);
  const closePop = useShopUi((s) => s.closePop);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click nền để đóng; bàn phím dùng Esc
    <div
      id="menuPop"
      className={item ? "open" : ""}
      role="dialog"
      aria-modal="true"
      aria-label={item?.name ?? "Chi tiết món"}
      onClick={(e) => e.target === e.currentTarget && closePop()}
    >
      {/* key = id: đổi món thì state số lượng reset về 1, như openMenuPop() gốc */}
      {item && <PopBody key={item.id} item={item} onClose={closePop} />}
    </div>
  );
}

function PopBody({ item, onClose }: { item: Product; onClose: () => void }) {
  const add = useCart((s) => s.add);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const meta = DISPLAY_META[item.id];
  const full = Math.max(0, Math.min(5, Math.round(item.rating)));

  useEffect(() => {
    if (!added) return;
    const t = setTimeout(onClose, 1000);
    return () => clearTimeout(t);
  }, [added, onClose]);

  return (
    <div className="mpbox">
      <button type="button" className="mpclose" id="mpClose" aria-label="Đóng" onClick={onClose}>
        <i className="fas fa-times" />
      </button>
      <div className="mpimg">
        <img id="mpImg" src={item.image} alt={item.name} />
      </div>
      <div className="mpbody">
        <div id="mpCat">{categoryLabel(item.category)}</div>
        <div id="mpTitle">{item.name}</div>
        <div id="mpStars">
          {Array.from({ length: full }, (_, i) => (
            <i className="fas fa-star" key={`f${i}`} />
          ))}
          {"☆".repeat(5 - full)}{" "}
          <span style={{ color: "#bbb", fontSize: ".78rem" }}>
            {item.rating} ({meta?.reviews ?? 0} đánh giá)
          </span>
        </div>
        <div id="mpDesc">{item.description}</div>
        <div id="mpPrice">
          {formatVnd(item.price)}
          {item.oldPrice > item.price && <small>{formatVnd(item.oldPrice)}</small>}
        </div>
        <div className="mpmeta" id="mpMeta">
          {meta && (
            <>
              <div className="mpm">
                <div className="mpmv">{meta.cal} kcal</div>
                <div className="mpml">Năng lượng</div>
              </div>
              <div className="mpm">
                <div className="mpmv">{meta.time} phút</div>
                <div className="mpml">Chuẩn bị</div>
              </div>
            </>
          )}
          <div className="mpm">
            <div className="mpmv">{item.rating}/5</div>
            <div className="mpml">Đánh giá</div>
          </div>
        </div>
        <div className="mpqty">
          <button
            type="button"
            className="mpqbtn"
            id="mpMinus"
            aria-label="Bớt"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
          >
            -
          </button>
          <span className="mpqnum" id="mpQnum" aria-live="polite">
            {qty}
          </span>
          <button
            type="button"
            className="mpqbtn"
            id="mpPlus"
            aria-label="Thêm"
            onClick={() => setQty((q) => Math.min(MAX_QTY, q + 1))}
          >
            +
          </button>
          <span style={{ fontSize: ".82rem", color: "#aaa", marginLeft: 9 }}>phần</span>
        </div>
        <div className="mptags" id="mpTags">
          {item.tags.map((t) => (
            <span className="mptag" key={t}>
              {t}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="mpaddcart"
          id="mpAddCart"
          disabled={added}
          style={added ? { background: "linear-gradient(135deg,var(--green),#1a4a35)" } : undefined}
          onClick={() => {
            add(item.id, qty);
            setAdded(true);
          }}
        >
          {added ? (
            <>
              <i className="fas fa-check" /> Đã thêm vào giỏ!
            </>
          ) : (
            <>
              <i className="fas fa-shopping-cart" />
              Thêm vào giỏ · {formatVnd(item.price * qty)}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
