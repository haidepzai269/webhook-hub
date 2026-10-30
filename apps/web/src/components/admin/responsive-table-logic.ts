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

/**
 * Tự co bảng theo bề rộng khung (ADR-271) — thứ tự CỐ ĐỊNH, không đo từng cột:
 *   1) ẩn dần cột phụ từ phải sang trái (cột chính + cột cuối/thao tác + cột người dùng tự bật thì GIỮ);
 *   2) vẫn tràn → "bóp": cho mọi ô xuống dòng ở bất kỳ ký tự nào (chuỗi dài không dấu cách như URL/id).
 * Hàm thuần: bước tiếp theo tính từ (trạng thái, có tràn không); đổi bề rộng/dữ liệu thì quay về `FIT_INITIAL` và chạy lại.
 */
export interface FitState {
  /** Số cột ứng viên đã ẩn (từ đầu danh sách `hideCandidates`). */
  hidden: number;
  crush: boolean;
}

export const FIT_INITIAL: FitState = { hidden: 0, crush: false };

/** Trả CHÍNH `s` khi đã ổn định (để React bỏ qua setState) — không thì trạng thái mới. */
export function fitStep(s: FitState, overflowing: boolean, candidates: number): FitState {
  if (!overflowing) return s;
  if (s.hidden < candidates) return { hidden: s.hidden + 1, crush: s.crush };
  if (!s.crush) return { hidden: s.hidden, crush: true };
  return s;
}

export interface FitColumn {
  id: string;
  canHide: boolean;
  /** Người dùng KHÔNG tắt cột này trong menu "Cột". */
  userVisible: boolean;
  /** Người dùng chủ động BẬT lại cột này — không tự ẩn nữa. */
  pinned: boolean;
}

/**
 * Cột nào được phép tự ẩn, theo thứ tự ẩn (phải → trái). Giữ: cột đầu, cột cuối (thường là thao tác), cột `keep`
 * (title/badge/actions của thẻ mobile), cột không ẩn được, cột đã bị tắt sẵn, cột người dùng ghim.
 */
export function hideCandidates(cols: readonly FitColumn[], keep: readonly string[] = []): string[] {
  const visible = cols.filter((c) => c.userVisible);
  const first = visible[0]?.id;
  const last = visible[visible.length - 1]?.id;
  const k = new Set(keep);
  return visible
    .filter((c) => c.canHide && !c.pinned && c.id !== first && c.id !== last && !k.has(c.id))
    .map((c) => c.id)
    .reverse();
}
