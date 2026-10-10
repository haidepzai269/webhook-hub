// Client gọi API của chính apps/shop. Không gọi hub, không nghe Socket.IO của hub (BB-1).
import { DEMO_SIMULATE, HUB_API_URL, SHOP_API_URL } from "@/lib/env";

export { DEMO_SIMULATE };

const SHOP_API = SHOP_API_URL;
const HUB_API = HUB_API_URL;
// Giả lập chỉ bật ở local (ADR-027). Key SePay KHÔNG hardcode ở đây: Next chỉ inline biến
// NEXT_PUBLIC_* khi nó được đặt lúc build, nên một chuỗi fallback sẽ lọt vào bundle deployed.
// Local: đặt NEXT_PUBLIC_DEMO_SEPAY_APIKEY trong apps/web/.env.local (giá trị = seed key).
const DEMO_SEPAY_APIKEY = process.env.NEXT_PUBLIC_DEMO_SEPAY_APIKEY ?? "";

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  oldPrice: number;
  image: string;
  description: string;
  rating: number;
  tags: string[];
}

export type OrderStatus = "PENDING" | "PAID" | "UNDERPAID" | "EXPIRED" | "CANCELLED";

export interface OrderLine {
  id: string;
  name: string;
  price: number;
  qty: number;
}

export interface CreatedOrder {
  orderCode: string;
  amount: number;
  status: OrderStatus;
  items: OrderLine[];
  qrCodeUrl: string;
}

export interface OrderState {
  orderCode: string;
  status: OrderStatus;
  amount: number;
  paidAmount: number;
}

export interface CustomerInput {
  name: string;
  phone: string;
  address?: string;
  note?: string;
}

export const formatVnd = (n: number) => `${n.toLocaleString("vi-VN")}đ`;

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error ?? `Lỗi ${res.status}`;
  } catch {
    return `Lỗi ${res.status}`;
  }
}

export async function fetchProducts(): Promise<Product[]> {
  const res = await fetch(`${SHOP_API}/products`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/** Chỉ gửi {id, qty}. Không bao giờ gửi amount/price — server tự tính (ADR-024). */
export async function createOrder(
  items: { id: string; qty: number }[],
  customer: CustomerInput,
): Promise<CreatedOrder> {
  const res = await fetch(`${SHOP_API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: items.map(({ id, qty }) => ({ id, qty })), customer, paymentProvider: "sepay" }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()).order;
}

export async function fetchOrder(code: string): Promise<OrderState> {
  const res = await fetch(`${SHOP_API}/orders/${encodeURIComponent(code)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/**
 * CHỈ DEMO LOCAL: bắn webhook SePay giả vào hub. Key ở đây là seed key local,
 * vì vậy hàm này chỉ được gọi khi DEMO_SIMULATE bật (không bao giờ ở deployed).
 */
export async function simulateSepayTransfer(orderCode: string, transferAmount: number): Promise<void> {
  if (!DEMO_SIMULATE) throw new Error("Giả lập bị tắt");
  if (!DEMO_SEPAY_APIKEY) throw new Error("Thiếu NEXT_PUBLIC_DEMO_SEPAY_APIKEY trong apps/web/.env.local");
  const res = await fetch(`${HUB_API}/hooks/sepay/src_sepay_main`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Apikey ${DEMO_SEPAY_APIKEY}`,
    },
    body: JSON.stringify({
      id: Date.now(),
      gateway: "MBBank",
      transactionDate: new Date().toISOString(),
      accountNumber: "0987654321",
      code: orderCode,
      content: `${orderCode} thanh toan don hang`,
      transferType: "in",
      transferAmount,
      description: `Chuyen khoan don ${orderCode}`,
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
}
