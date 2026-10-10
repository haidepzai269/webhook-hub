// Menu + tính tiền phía server (ADR-024, ADR-027). Không import Prisma để test thuần được.
export interface MenuItem {
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

const img = (n: number) => `/shop-assets/img/menu/${n}.jpg`;

export const MENU: MenuItem[] = [
  { id: 'm1', name: 'Burger bò smash cổ điển', category: 'burgers', price: 69000, oldPrice: 89000, image: img(1), description: 'Hai lớp bò smash, phô mai cheddar tan chảy, sốt nhà làm.', rating: 5, tags: ['Bán chạy'] },
  { id: 'm2', name: 'Pizza Margherita Hoàng gia', category: 'pizza', price: 129000, oldPrice: 159000, image: img(2), description: 'Đế mỏng nướng lò củi, cà chua San Marzano, mozzarella tươi, húng quế.', rating: 5, tags: ['Chay'] },
  { id: 'm3', name: 'Gà rán cay Nashville', category: 'chicken', price: 79000, oldPrice: 99000, image: img(3), description: 'Gà giòn rụm phủ dầu ớt cay kiểu Nashville, kèm dưa chua.', rating: 4, tags: ['Cay'] },
  { id: 'm4', name: 'Wrap gà Fajita', category: 'wraps', price: 59000, oldPrice: 75000, image: img(4), description: 'Gà nướng fajita, ớt chuông, hành tây, sốt kem chua cuộn bánh tortilla.', rating: 4, tags: ['Mới'] },
  { id: 'm5', name: 'Bánh Lava Nutella', category: 'desserts', price: 45000, oldPrice: 55000, image: img(5), description: 'Bánh sô-cô-la nóng, nhân Nutella chảy, kèm kem vani.', rating: 5, tags: ['Ngọt'] },
  { id: 'm6', name: 'Mì Ý nấm Truffle', category: 'pasta', price: 99000, oldPrice: 119000, image: img(6), description: 'Mì fettuccine sốt kem nấm, dầu truffle và phô mai Parmesan.', rating: 5, tags: ['Đặc biệt'] },
];

export interface OrderLine { id: string; name: string; price: number; qty: number }
export interface Customer { name: string; phone: string; address?: string; note?: string }
export type PricedOrder =
  | { ok: true; amount: number; items: OrderLine[]; customer: Customer }
  | { ok: false; error: string };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Kiểm tra body và tính tổng ở server. Mọi trường `amount` trong body đều bị bỏ qua. */
export function priceOrder(body: any): PricedOrder {
  const rawItems = body?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { ok: false, error: 'Giỏ hàng rỗng' };
  if (rawItems.length > 50) return { ok: false, error: 'Quá nhiều dòng trong giỏ' };

  const merged = new Map<string, number>();
  for (const it of rawItems) {
    const menuItem = MENU.find((m) => m.id === it?.id);
    if (!menuItem) return { ok: false, error: `Món không tồn tại: ${typeof it?.id === 'string' ? it.id.slice(0, 32) : '?'}` };
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 20) return { ok: false, error: 'Số lượng phải là số nguyên 1–20' };
    const qty = (merged.get(menuItem.id) ?? 0) + it.qty;
    if (qty > 20) return { ok: false, error: 'Số lượng phải là số nguyên 1–20' };
    merged.set(menuItem.id, qty);
  }

  const name = str(body?.customer?.name, 100);
  const phone = str(body?.customer?.phone, 20);
  if (!name || !phone) return { ok: false, error: 'Thiếu tên hoặc số điện thoại' };
  if (!/^[0-9+\s.-]{8,20}$/.test(phone) || phone.replace(/\D/g, '').length < 8) return { ok: false, error: 'Số điện thoại không hợp lệ' };
  const customer: Customer = { name, phone };
  const address = str(body.customer.address, 300);
  const note = str(body.customer.note, 300);
  if (address) customer.address = address;
  if (note) customer.note = note;

  const items: OrderLine[] = [...merged].map(([id, qty]) => {
    const m = MENU.find((x) => x.id === id)!;
    return { id, name: m.name, price: m.price, qty };
  });
  const amount = items.reduce((sum, l) => sum + l.price * l.qty, 0);
  return { ok: true, amount, items, customer };
}

/** GET /orders/:code là public (mã đơn đoán được) → chỉ trả tên + SĐT đã che. */
export function maskCustomer(c: Customer | null): { name: string; phone: string } | null {
  if (!c) return null;
  return { name: maskName(c.name), phone: c.phone.length > 3 ? `${'*'.repeat(c.phone.length - 3)}${c.phone.slice(-3)}` : '***' };
}

/** "Nguyễn Văn An" → "Nguyễn V. A." — đủ để khách nhận ra đơn, không lộ họ tên đầy đủ. */
function maskName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  return [first, ...rest.map((w) => `${w[0]}.`)].join(' ');
}
