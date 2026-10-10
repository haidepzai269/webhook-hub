import { Graph, layout } from "@dagrejs/dagre";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

/** Bố cục trái → phải bằng dagre. Trả toạ độ GÓC TRÊN TRÁI (React Flow dùng góc, dagre trả tâm). */
export function layoutLR(
  nodes: LayoutNode[],
  edges: { source: string; target: string }[],
  opts: { ranksep?: number; nodesep?: number } = {},
): Record<string, { x: number; y: number }> {
  const g = new Graph();
  g.setGraph({ rankdir: "LR", ranksep: opts.ranksep ?? 90, nodesep: opts.nodesep ?? 36, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    if (p) out[n.id] = { x: p.x - n.width / 2, y: p.y - n.height / 2 };
  }
  return out;
}
