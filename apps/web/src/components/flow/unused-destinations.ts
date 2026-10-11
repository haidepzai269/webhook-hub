/**
 * Đích "không dùng": không còn subscription ĐANG BẬT nào trỏ tới, và không có việc gì trong cửa sổ
 * (không traffic, không đang thử lại). Ví dụ endpoint cũ xác minh lỗi (ssrf_blocked) đã bị thay — nó
 * không phải sự cố đang cháy nên không được phát sáng đỏ "CRASHED"; UI vẽ mờ "không dùng" thay vào.
 * Kiểu cấu trúc tối thiểu (không phụ thuộc @hub/flow) để test thuần được.
 */
interface NodeLike {
  id: string;
  kind: string;
  destinationId?: string;
  active?: boolean;
  retrying?: number;
}
interface EdgeLike {
  target: string;
  count: number;
  retrying: number;
}

export function unusedDestinationIds(topo: { nodes: readonly NodeLike[]; edges: readonly EdgeLike[] }): Set<string> {
  const used = new Set<string>();
  for (const n of topo.nodes)
    if (n.kind === "subscription" && n.active && n.destinationId) used.add(`dst:${n.destinationId}`);
  for (const e of topo.edges) if (e.count > 0 || e.retrying > 0) used.add(e.target);
  const out = new Set<string>();
  for (const n of topo.nodes) {
    if (n.kind !== "destination" || used.has(n.id) || (n.retrying ?? 0) > 0) continue;
    out.add(n.id);
  }
  return out;
}
