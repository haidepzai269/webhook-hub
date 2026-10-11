"use client";

import { useEffect, useRef, useState } from "react";

import { QRCodeSVG } from "qrcode.react";

import {
  type CreatedOrder,
  type CustomerInput,
  createOrder,
  DEMO_SIMULATE,
  fetchOrder,
  fetchPaymentOptions,
  formatVnd,
  type OrderState,
  type OrderStatus,
  type PaymentOptions,
  type PaymentProvider,
  simulateSepayTransfer,
} from "@/lib/shop/api";
import { cartSubtotal, useCart } from "@/lib/shop/cart";
import {
  canTopUp,
  cartSignature,
  isFinalStatus,
  orderCodeFromSearch,
  parseSavedOrder,
  paymentQr,
  pollDeadline,
  shouldStartNewOrder,
} from "@/lib/shop/order-status";
import { useShopUi } from "@/lib/shop/ui";

const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // dự phòng khi server không trả expiresAt
const PHONE_RE = /^[0-9+\s.-]{8,20}$/; // khớp validate của apps/shop
const SAVED_ORDER_KEY = "shop:order"; // M-2 (SK4): đơn đang xử lý sống qua tải lại trang, chỉ trong tab này

/** Đơn phía web: kèm chữ ký giỏ lúc tạo (giỏ đổi -> đơn mới, không dùng lại QR cũ). */
type ShopOrder = CreatedOrder & { cartSig?: string };

const session = {
  get: () => {
    try {
      return sessionStorage.getItem(SAVED_ORDER_KEY);
    } catch {
      return null;
    }
  },
  set: (o: ShopOrder | null) => {
    try {
      if (o) sessionStorage.setItem(SAVED_ORDER_KEY, JSON.stringify(o));
      else sessionStorage.removeItem(SAVED_ORDER_KEY);
    } catch {
      /* tab không cho lưu: chỉ mất khi tải lại */
    }
  },
};

type Errors = Partial<Record<keyof CustomerInput, string>>;

function validate(c: CustomerInput): Errors {
  const e: Errors = {};
  if (!c.name.trim()) e.name = "Vui lòng nhập họ tên";
  if (!c.phone.trim()) e.phone = "Vui lòng nhập số điện thoại";
  else if (!PHONE_RE.test(c.phone.trim())) e.phone = "Số điện thoại không hợp lệ";
  return e;
}

export function CheckoutModal() {
  const open = useShopUi((s) => s.checkoutOpen);
  const setCheckoutOpen = useShopUi((s) => s.setCheckoutOpen);
  const products = useShopUi((s) => s.products);
  const items = useCart((s) => s.items);
  const clearCart = useCart((s) => s.clear);

  const [customer, setCustomer] = useState<CustomerInput>({ name: "", phone: "", address: "", note: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Đơn hiện tại sống qua việc đóng/mở modal: đóng lúc đang chờ thì mở lại vẫn thấy QR.
  const [order, setOrder] = useState<ShopOrder | null>(null);
  const [state, setState] = useState<OrderState | null>(null);
  const [pollStartedAt, setPollStartedAt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  // P1 (ADR-141): khách chọn PayOS (link + VietQR do PayOS cấp) hay chuyển khoản thẳng (SePay đọc biến động số dư).
  const [options, setOptions] = useState<PaymentOptions | null>(null);
  const [provider, setProvider] = useState<PaymentProvider>("payos");
  const submittingRef = useRef(false); // chặn double-submit trong cùng một frame

  const status: OrderStatus | null = state?.status ?? order?.status ?? null;
  // R2-L1: EXPIRED chưa cuối trong cửa sổ grace — khoản trả đúng hạn có webhook tới muộn vẫn thành PAID (ADR-144).
  const finished = status !== null && isFinalStatus(status, order?.expiresAt, Date.now());
  const orderCode = order?.orderCode;
  const qr = order ? paymentQr(order.payment) : null;

  // Mở modal -> hỏi Shop có PayOS không; mặc định PayOS nếu Shop đã cấu hình, không thì chuyển khoản.
  useEffect(() => {
    if (!open || options) return;
    fetchPaymentOptions()
      .then((o) => {
        setOptions(o);
        setProvider(o.payos ? "payos" : "sepay");
      })
      .catch(() => setProvider("sepay"));
  }, [open, options]);

  const deadline = pollDeadline(order?.expiresAt, pollStartedAt + POLL_TIMEOUT_MS);

  // Poll GET /orders/:code mỗi 2s. Dừng khi: trạng thái cuối, đóng modal, hoặc quá hạn đơn + grace.
  useEffect(() => {
    if (!open || !orderCode || finished || timedOut) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (Date.now() > deadline) {
        setTimedOut(true);
        return;
      }
      try {
        const s = await fetchOrder(orderCode);
        if (!alive) return;
        setState(s);
        if (isFinalStatus(s.status, order?.expiresAt, Date.now())) return;
      } catch {
        /* mạng chập chờn: thử lại ở nhịp sau */
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, orderCode, finished, timedOut, deadline, order?.expiresAt]);

  // PAID → xoá giỏ (một lần)
  useEffect(() => {
    if (status === "PAID") clearCart();
  }, [status, clearCart]);

  // M-2 (SK4): tải lại trang -> lấy lại đơn của tab; PayOS đưa khách về `?order=DH…` -> mở modal xem trạng thái đơn đó.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ chạy một lần khi mount
  useEffect(() => {
    const code = orderCodeFromSearch(window.location.search);
    const saved = parseSavedOrder<ShopOrder>(session.get());
    if (saved && (!code || saved.orderCode === code)) setOrder(saved);
    else if (code) {
      fetchOrder(code)
        .then((s) =>
          setOrder({
            orderCode: s.orderCode,
            amount: s.amount,
            status: s.status,
            items: [],
            paymentProvider: "payos", // chỉ returnUrl của PayOS mang ?order=
            expiresAt: s.expiresAt ?? new Date().toISOString(),
            payment: { qrImageUrl: null },
          }),
        )
        .catch(() => undefined);
    }
    if (code) {
      setCheckoutOpen(true);
      window.history.replaceState(null, "", window.location.pathname); // không mở lại mỗi lần F5
    }
  }, []);

  useEffect(() => session.set(order), [order]);

  // Mở modal: giỏ đã khác lúc tạo đơn -> đơn mới (lỗi QR cũ); còn lại -> hỏi trạng thái MỘT lần (M-2: trả muộn vẫn thấy PAID).
  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ chạy ở cạnh "mở modal"
  useEffect(() => {
    if (!open || !order) return;
    if (shouldStartNewOrder(order, cartSignature(items))) {
      resetOrder();
      return;
    }
    fetchOrder(order.orderCode)
      .then(setState)
      .catch(() => undefined);
  }, [open, order?.orderCode]);

  // Esc đóng modal
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setCheckoutOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setCheckoutOpen]);

  const resetOrder = () => {
    setOrder(null);
    setState(null);
    setTimedOut(false);
    setSimError(null);
    setSubmitError(null);
  };

  const close = () => {
    setCheckoutOpen(false);
    if (finished || timedOut) resetOrder();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate(customer);
    setErrors(errs);
    if (Object.keys(errs).length > 0 || items.length === 0 || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createOrder(
        items,
        {
          name: customer.name.trim(),
          phone: customer.phone.trim(),
          address: customer.address?.trim() || undefined,
          note: customer.note?.trim() || undefined,
        },
        provider,
      );
      setOrder({ ...created, cartSig: cartSignature(items) });
      setState(null);
      setTimedOut(false);
      setPollStartedAt(Date.now());
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Không tạo được đơn");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const simulate = async (amount: number) => {
    if (!order) return;
    setSimBusy(true);
    setSimError(null);
    try {
      await simulateSepayTransfer(order.orderCode, amount);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : "Lỗi bắn webhook");
    } finally {
      setSimBusy(false);
    }
  };

  const field = (k: keyof CustomerInput) => ({
    value: customer[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCustomer((c) => ({ ...c, [k]: e.target.value })),
  });

  const amount = order?.amount ?? 0;
  const paid = state?.paidAmount ?? 0;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click nền để đóng; bàn phím dùng Esc
    <div
      id="checkoutPop"
      className={open ? "open" : ""}
      role="dialog"
      aria-modal="true"
      aria-label="Thanh toán"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="ckbox">
        <button type="button" className="mpclose" aria-label="Đóng" onClick={close}>
          <i className="fas fa-times" />
        </button>

        <ol className="cksteps" aria-label="Các bước">
          <li className={!order ? "active" : "done"}>Thông tin</li>
          <li className={order && status !== "PAID" ? "active" : status === "PAID" ? "done" : ""}>Chuyển khoản</li>
          <li className={status === "PAID" ? "active" : ""}>Hoàn tất</li>
        </ol>

        {!order && (
          <form onSubmit={submit} noValidate>
            <h4 className="cktitle">Thông tin nhận món</h4>
            <div className="row g-3">
              <div className="col-sm-6">
                <label className="cklabel" htmlFor="ckName">
                  Họ tên *
                </label>
                <input id="ckName" className="form-control" autoComplete="name" maxLength={100} {...field("name")} />
                {errors.name && <small className="ckerr">{errors.name}</small>}
              </div>
              <div className="col-sm-6">
                <label className="cklabel" htmlFor="ckPhone">
                  Số điện thoại *
                </label>
                <input
                  id="ckPhone"
                  className="form-control"
                  type="tel"
                  autoComplete="tel"
                  maxLength={20}
                  {...field("phone")}
                />
                {errors.phone && <small className="ckerr">{errors.phone}</small>}
              </div>
              <div className="col-12">
                <label className="cklabel" htmlFor="ckAddr">
                  Địa chỉ giao hàng
                </label>
                <input
                  id="ckAddr"
                  className="form-control"
                  autoComplete="street-address"
                  maxLength={300}
                  {...field("address")}
                />
              </div>
              <div className="col-12">
                <label className="cklabel" htmlFor="ckNote">
                  Ghi chú
                </label>
                <textarea id="ckNote" className="form-control" rows={2} maxLength={300} {...field("note")} />
              </div>
            </div>
            <fieldset className="mt-3">
              <legend className="cklabel">Cách thanh toán</legend>
              <label className="d-flex gap-2 align-items-center">
                <input
                  type="radio"
                  name="ckProvider"
                  value="payos"
                  checked={provider === "payos"}
                  disabled={options !== null && !options.payos}
                  onChange={() => setProvider("payos")}
                />
                PayOS — quét VietQR hoặc mở trang thanh toán
                {options !== null && !options.payos && <small className="ckerr">(Shop chưa cấu hình PayOS)</small>}
              </label>
              <label className="d-flex gap-2 align-items-center">
                <input
                  type="radio"
                  name="ckProvider"
                  value="sepay"
                  checked={provider === "sepay"}
                  onChange={() => setProvider("sepay")}
                />
                Chuyển khoản ngân hàng (SePay xác nhận)
              </label>
            </fieldset>
            <div className="cartsum mt-3">
              <span>Tạm tính ({items.length} món)</span>
              <strong>{formatVnd(cartSubtotal(items, products))}</strong>
            </div>
            {submitError && <p className="ckerr mt-2">{submitError}</p>}
            <button type="submit" className="mpaddcart mt-3" disabled={submitting || items.length === 0}>
              {submitting ? (
                <>
                  <i className="fas fa-spinner fa-spin" /> Đang tạo đơn...
                </>
              ) : (
                <>
                  <i className="fas fa-qrcode" /> Tạo đơn &amp; lấy mã QR
                </>
              )}
            </button>
          </form>
        )}

        {order && status !== "PAID" && (
          <div className="ckpay">
            <div className="ckcurrent">
              <span>
                Đơn <strong>{order.orderCode}</strong> · {formatVnd(amount)}
              </span>
              <button type="button" className="ckcancel" onClick={resetOrder}>
                Tạo đơn mới
              </button>
            </div>
            <h4 className="cktitle">Quét VietQR bằng app ngân hàng</h4>
            {qr?.kind === "code" ? (
              // Q3 (ADR-154): vẽ VietQR của PayOS ngay tại trình duyệt — dữ liệu thanh toán không đi qua bên thứ ba
              <figure className="ckqrbox">
                <QRCodeSVG
                  className="ckqr"
                  value={qr.value}
                  size={280}
                  level="M"
                  marginSize={3}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  title={`Mã VietQR thanh toán đơn ${order.orderCode}`}
                />
                <figcaption className="ckqrcap">
                  <strong>{formatVnd(amount)}</strong> · {order.orderCode}
                </figcaption>
              </figure>
            ) : qr?.kind === "image" ? (
              <img
                className="ckqr"
                src={qr.url}
                alt={`Mã VietQR thanh toán đơn ${order.orderCode}`}
                width={260}
                height={260}
              />
            ) : (
              <p className="ckerr">
                Shop chưa cấu hình tài khoản ngân hàng nhận tiền nên không có mã QR. Hãy chọn PayOS, hoặc chuyển khoản
                thủ công với nội dung bên dưới.
              </p>
            )}
            {order.payment.checkoutUrl && (
              <a
                className="mpaddcart mt-2 d-inline-block"
                href={order.payment.checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <i className="fas fa-external-link-alt" /> Mở trang thanh toán PayOS
              </a>
            )}
            <div className="ckcode-lbl">
              {order.paymentProvider === "payos"
                ? "Mã đơn (đã có sẵn trong mã QR PayOS)"
                : "Nội dung chuyển khoản (ghi ĐÚNG mã này)"}
            </div>
            <div className="ckcode">{order.orderCode}</div>
            <div className="ckamount">
              Số tiền: <strong>{formatVnd(amount)}</strong>
            </div>
            <ul className="ckitems">
              {order.items.map((l) => (
                <li key={l.id}>
                  <span>
                    {l.qty} × {l.name}
                  </span>
                  <span>{formatVnd(l.price * l.qty)}</span>
                </li>
              ))}
            </ul>

            <div
              className={`ckstatus ck-${(timedOut ? "TIMEOUT" : (status ?? "PENDING")).toLowerCase()}`}
              aria-live="polite"
            >
              {timedOut && status !== "EXPIRED" ? (
                <>
                  <i className="fas fa-hourglass-end" /> Đã hết thời gian chờ. Nếu bạn đã chuyển khoản, vui lòng liên hệ
                  hotline với mã {order.orderCode}.
                </>
              ) : status === "UNDERPAID" ? (
                <>
                  <i className="fas fa-exclamation-triangle" /> Đã nhận {formatVnd(paid)}, còn thiếu{" "}
                  <strong>{formatVnd(Math.max(0, amount - paid))}</strong>. Vui lòng gọi hotline 1900 6868 kèm mã{" "}
                  {order.orderCode}
                  {canTopUp(order.paymentProvider)
                    ? " hoặc chuyển thêm phần còn thiếu với cùng nội dung (Shop cộng dồn các lần chuyển)."
                    : "."}
                </>
              ) : status === "EXPIRED" && paid > 0 ? (
                <>
                  <i className="fas fa-exclamation-triangle" /> Đơn đã hết hạn, Shop đã nhận{" "}
                  <strong>{formatVnd(paid)}</strong>, còn thiếu <strong>{formatVnd(Math.max(0, amount - paid))}</strong>
                  .{" "}
                  {canTopUp(order.paymentProvider)
                    ? "Chuyển thêm phần còn thiếu với cùng nội dung để hoàn tất đơn, hoặc gọi"
                    : "Vui lòng gọi"}{" "}
                  hotline 1900 6868 kèm mã {order.orderCode} để được giao món hoặc hoàn tiền.
                </>
              ) : status === "EXPIRED" && !finished && !timedOut ? (
                <>
                  <i className="fas fa-spinner fa-spin" /> Đơn đã quá hạn. Nếu bạn vừa chuyển khoản, Shop đang chờ xác
                  nhận (tối đa vài phút)…
                </>
              ) : status === "EXPIRED" || status === "CANCELLED" ? (
                <>
                  <i className="fas fa-times-circle" /> Đơn đã {status === "EXPIRED" ? "hết hạn" : "bị huỷ"}.
                </>
              ) : (
                <>
                  <i className="fas fa-spinner fa-spin" /> Đang chờ thanh toán…
                </>
              )}
            </div>

            {DEMO_SIMULATE && !finished && !timedOut && (
              <div className="cksim">
                <div className="cksim-lbl">Chỉ có ở môi trường demo local</div>
                <div className="d-flex gap-2 flex-wrap justify-content-center">
                  <button type="button" className="btn-red" disabled={simBusy} onClick={() => simulate(amount)}>
                    <i className="fas fa-bolt" /> Giả lập chuyển khoản
                  </button>
                  <button
                    type="button"
                    className="btn-red ckbtn-ghost"
                    disabled={simBusy}
                    onClick={() => simulate(Math.max(1000, Math.floor(amount / 2)))}
                  >
                    Giả lập chuyển thiếu
                  </button>
                </div>
                {simError && <p className="ckerr mt-2">{simError}</p>}
              </div>
            )}

            {finished || timedOut ? (
              <button type="button" className="mpaddcart mt-3" onClick={resetOrder}>
                Tạo đơn mới
              </button>
            ) : (
              <button type="button" className="ckcancel mt-3" onClick={resetOrder}>
                Đổi món / tạo đơn mới
              </button>
            )}
          </div>
        )}

        {order && status === "PAID" && (
          <div className="ckdone">
            <i className="fas fa-check-circle" />
            <h4 className="cktitle">Đã thanh toán!</h4>
            <p>
              Đơn <strong>{order.orderCode}</strong> đã nhận {formatVnd(paid || amount)}. Bếp đang chuẩn bị món cho bạn.
            </p>
            <button type="button" className="mpaddcart mt-3" onClick={close}>
              Tiếp tục xem thực đơn
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
