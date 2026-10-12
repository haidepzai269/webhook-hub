/**
 * ADR-161: "Ngắt" (is_active=false) trên bản đồ luồng — mục đã ngắt LUÔN ở lại bản đồ, vẽ mờ, ở MỌI chế độ xem
 * (cột Subscription, nhóm subscription gộp, nhãn cạnh gộp). Không có bộ lọc nào được ẩn nó. Kiểu cấu trúc tối thiểu
 * (không phụ thuộc @hub/flow) để test thuần được.
 */
interface NodeLike {
  id: string;
  kind: string;
  active?: boolean;
}

/** Source / đích / subscription (kể cả nhóm `subgroup:`) có `active === false`. Gate / normalize không bao giờ. */
export function isDisconnected(node: NodeLike): boolean {
  return (node.kind === "source" || node.kind === "destination" || node.kind === "subscription") && node.active === false;
}

/** Nhóm subscription gộp chỉ "đã ngắt" khi MỌI subscription trong nhóm đã ngắt (còn một cái chạy = nhóm còn chạy). */
export function groupActive(group: readonly { active?: boolean }[]): boolean {
  return group.some((g) => g.active !== false);
}

/** Nhãn cạnh gộp: số subscription đã ngắt trong nhóm (rỗng nếu không có) — gộp vào nhãn vẫn phải thấy được "đã ngắt". */
export function disconnectedNote(group: readonly { active?: boolean }[]): string {
  const off = group.filter((g) => g.active === false).length;
  if (off === 0) return "";
  return off === group.length ? "đã ngắt" : `${off} đã ngắt`;
}
