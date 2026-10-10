"use client";

import { formatVnd } from "@/lib/shop/api";
import { cartCount, cartSubtotal, MAX_QTY, useCart } from "@/lib/shop/cart";
import { useShopUi } from "@/lib/shop/ui";

/** Nút giỏ nổi — khối `.cartfl` bị comment trong template, bật lại ở đây. */
export function CartFloat() {
  const count = useCart((s) => cartCount(s.items));
  const setCartOpen = useShopUi((s) => s.setCartOpen);
  return (
    <button type="button" className="cartfl" aria-label={`Giỏ hàng (${count} món)`} onClick={() => setCartOpen(true)}>
      <i className="fas fa-shopping-cart" />
      <span>Giỏ hàng</span>
      <div className="ccount" id="cartCount">
        {count}
      </div>
    </button>
  );
}

/** Ngăn giỏ hàng (không có trong template) — dựng bằng biến màu của style.css. */
export function CartDrawer() {
  const open = useShopUi((s) => s.cartOpen);
  const products = useShopUi((s) => s.products);
  const { setCartOpen, setCheckoutOpen } = useShopUi.getState();
  const items = useCart((s) => s.items);
  const { setQty, remove } = useCart.getState();
  const subtotal = cartSubtotal(items, products);
  const close = () => setCartOpen(false);

  return (
    <div
      id="cartOv"
      className={open ? "open" : ""}
      aria-hidden={!open}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <aside className="cartbox" role="dialog" aria-modal="true" aria-label="Giỏ hàng">
        <div className="carthead">
          <h4>
            <i className="fas fa-shopping-cart" /> Giỏ hàng <span>({cartCount(items)})</span>
          </h4>
          <button type="button" className="mpclose" aria-label="Đóng giỏ hàng" onClick={close}>
            <i className="fas fa-times" />
          </button>
        </div>

        <div className="cartlist">
          {items.length === 0 && (
            <div className="cartempty">
              <i className="fas fa-utensils" />
              <p>Giỏ hàng đang trống. Chọn vài món ngon nhé!</p>
            </div>
          )}
          {items.map((l) => {
            const p = products.find((x) => x.id === l.id);
            return (
              <div className="cartline" key={l.id}>
                {p ? <img src={p.image} alt={p.name} loading="lazy" /> : <div className="cartimg-ph" />}
                <div className="cartinfo">
                  <div className="cartname">{p?.name ?? "Đang tải…"}</div>
                  <div className="cartprice">{p ? formatVnd(p.price) : "—"}</div>
                  <div className="mpqty">
                    <button type="button" className="mpqbtn" aria-label="Bớt" onClick={() => setQty(l.id, l.qty - 1)}>
                      -
                    </button>
                    <span className="mpqnum">{l.qty}</span>
                    <button
                      type="button"
                      className="mpqbtn"
                      aria-label="Thêm"
                      disabled={l.qty >= MAX_QTY}
                      onClick={() => setQty(l.id, l.qty + 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="cartdel"
                  aria-label={`Xoá ${p?.name ?? "món"}`}
                  onClick={() => remove(l.id)}
                >
                  <i className="fas fa-trash-alt" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="cartfoot">
          <div className="cartsum">
            <span>Tạm tính</span>
            <strong>{formatVnd(subtotal)}</strong>
          </div>
          <p className="cartnote">Số tiền chính thức do nhà hàng xác nhận khi tạo đơn.</p>
          <button
            type="button"
            className="mpaddcart"
            disabled={items.length === 0}
            onClick={() => {
              close();
              setCheckoutOpen(true);
            }}
          >
            <i className="fas fa-lock" /> Thanh toán
          </button>
        </div>
      </aside>
    </div>
  );
}
