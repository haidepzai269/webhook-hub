/**
 * Bảng → danh sách thẻ dưới `md` (ADR-261). Mỗi bảng khai báo ĐÚNG MỘT `MobileCardSpec` theo id cột; hàm thuần này chọn cột
 * nào lên thẻ từ tập cột đang hiện (cột bị ẩn / không tồn tại thì bỏ), để DataTable chỉ việc vẽ và test được riêng.
 */
export interface MobileCardSpec {
  /** Cột làm dòng tiêu đề của thẻ (đậm, chiếm bề ngang còn lại). */
  title: string;
  /** Cột nhỏ bên phải tiêu đề (trạng thái, mức độ). */
  badge?: string;
  /** Các cột phụ — lưới 2 cột "nhãn / giá trị". Cột nào cần cả hàng thì ghi thêm vào `wide`. */
  meta?: string[];
  wide?: string[];
  /** Cột thao tác (nút Replay…) — cuối thẻ, nút cao ≥ 40px. */
  actions?: string;
}

export interface MobileCardPlan {
  title: string | null;
  badge: string | null;
  meta: { id: string; wide: boolean }[];
  actions: string | null;
}

export function planMobileCard(spec: MobileCardSpec, visibleIds: readonly string[]): MobileCardPlan {
  const has = new Set(visibleIds);
  const pick = (id: string | undefined) => (id && has.has(id) ? id : null);
  const wide = new Set(spec.wide ?? []);
  const title = pick(spec.title);
  const badge = pick(spec.badge);
  const actions = pick(spec.actions);
  const meta = (spec.meta ?? []).filter((id) => has.has(id) && id !== title && id !== badge && id !== actions);
  return { title, badge, meta: [...new Set(meta)].map((id) => ({ id, wide: wide.has(id) })), actions };
}
