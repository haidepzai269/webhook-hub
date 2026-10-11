/**
 * Trạng thái SỐNG của chặng trên bản đồ luồng (kiểu n8n) — logic thuần, không React.
 *
 * Một "chặng" (hop) là một cạnh hoặc một node, khoá bằng id của nó. Socket bắn mốc bắt đầu/kết thúc
 * theo từng sự kiện (token = rawEventId / deliveryId):
 *  - running : còn ít nhất một token đang bay (chưa hết TTL)  → cạnh nét đứt chạy, node có spinner;
 *  - ok/warn/fail : vừa kết thúc → cạnh liền xanh/vàng/đỏ một lúc rồi lắng;
 *  - idle    : không gì đang bay → cạnh liền, mờ; KHÔNG animation.
 * TTL bảo đảm mất socket/normalize chết không làm bản đồ quay mãi; trần token chặn burst phình bộ nhớ.
 * Số liệu cửa sổ (ev/15m, latency) vẫn do server đếm — reducer này chỉ tô hiệu ứng.
 */

export type LiveResult = "ok" | "warn" | "fail";
export type LiveView = "running" | LiveResult | "idle";

/** Quá hạn này mà chưa có mốc kết thúc → coi như không còn bay (delivery timeout là 5s). */
export const IN_FLIGHT_TTL_MS = 15_000;
/** Xanh "vừa xong" giữ bao lâu rồi lắng về idle. */
export const SUCCESS_SETTLE_MS = 2_500;
/** Đỏ/vàng giữ lâu hơn để kịp nhìn thấy. */
export const FAIL_HOLD_MS = 8_000;
export const MAX_TOKENS_PER_HOP = 50;

export interface LiveHop {
  /** token → hạn chót (ms). */
  inflight: Record<string, number>;
  result?: { kind: LiveResult; until: number };
}

export interface LiveState {
  hops: Record<string, LiveHop>;
}

export function emptyLive(): LiveState {
  return { hops: {} };
}

function holdOf(kind: LiveResult): number {
  return kind === "ok" ? SUCCESS_SETTLE_MS : FAIL_HOLD_MS;
}

/** Đánh dấu `token` bắt đầu bay trên các chặng `keys`. */
export function liveStart(s: LiveState, keys: string[], token: string, now: number): LiveState {
  if (!keys.length) return s;
  const hops = { ...s.hops };
  for (const k of keys) {
    const prev = hops[k];
    let inflight = { ...(prev?.inflight ?? {}), [token]: now + IN_FLIGHT_TTL_MS };
    const ids = Object.keys(inflight);
    if (ids.length > MAX_TOKENS_PER_HOP) {
      // Bỏ token sắp hết hạn nhất (cũ nhất) — chặng vẫn "running", chỉ không nhớ hết từng cái.
      ids.sort((a, b) => inflight[a] - inflight[b]);
      const keep = ids.slice(ids.length - MAX_TOKENS_PER_HOP);
      inflight = Object.fromEntries(keep.map((id) => [id, inflight[id]]));
    }
    hops[k] = { ...prev, inflight };
  }
  return { hops };
}

/** `token` kết thúc trên các chặng `keys` với kết quả `kind` (không cần start trước). */
export function liveEnd(s: LiveState, keys: string[], token: string, kind: LiveResult, now: number): LiveState {
  if (!keys.length) return s;
  const hops = { ...s.hops };
  for (const k of keys) {
    const prev = hops[k];
    const inflight = { ...(prev?.inflight ?? {}) };
    delete inflight[token];
    // Lỗi không bị "ok" của sự kiện khác ghi đè khi lỗi còn đang hiện.
    const keepPrev = prev?.result && prev.result.until > now && prev.result.kind !== "ok" && kind === "ok";
    hops[k] = { inflight, result: keepPrev ? prev.result : { kind, until: now + holdOf(kind) } };
  }
  return { hops };
}

export function liveView(s: LiveState, key: string, now: number): LiveView {
  const hop = s.hops[key];
  if (!hop) return "idle";
  for (const exp of Object.values(hop.inflight)) if (exp > now) return "running";
  if (hop.result && hop.result.until > now) return hop.result.kind;
  return "idle";
}

/** Dọn token/kết quả hết hạn; `nextWakeAt` = mốc gần nhất cần vẽ lại (null = không còn gì sống). */
export function livePrune(s: LiveState, now: number): { state: LiveState; nextWakeAt: number | null } {
  const hops: Record<string, LiveHop> = {};
  let next: number | null = null;
  const see = (t: number) => {
    if (next === null || t < next) next = t;
  };
  for (const [k, hop] of Object.entries(s.hops)) {
    const inflight: Record<string, number> = {};
    for (const [tok, exp] of Object.entries(hop.inflight)) {
      if (exp > now) {
        inflight[tok] = exp;
        see(exp);
      }
    }
    const result = hop.result && hop.result.until > now ? hop.result : undefined;
    if (result) see(result.until);
    if (Object.keys(inflight).length || result) hops[k] = result ? { inflight, result } : { inflight };
  }
  return { state: { hops }, nextWakeAt: next };
}

/** Một mốc socket chờ áp — gom theo khung hình rồi áp một lần (L-B2: burst không thành bão render). */
export type LiveOp =
  | { op: "start"; keys: string[]; token: string; at: number }
  | { op: "end"; keys: string[]; token: string; kind: LiveResult; at: number };

/** Áp tuần tự các mốc đã gom (giống gọi từng reducer, giữ đúng thứ tự và thời điểm). */
export function liveApplyBatch(s: LiveState, ops: readonly LiveOp[]): LiveState {
  let out = s;
  for (const o of ops)
    out = o.op === "start" ? liveStart(out, o.keys, o.token, o.at) : liveEnd(out, o.keys, o.token, o.kind, o.at);
  return out;
}

/** So nông: cùng tập khoá và từng giá trị `===`. */
export function sameShallow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || a[k] !== b[k]) return false;
  return true;
}

/**
 * Giữ object cũ (theo `id`) khi `same(old, next)` — node/cạnh memo không render lại; không phần tử nào đổi
 * (cùng độ dài, cùng thứ tự) → trả nguyên mảng cũ.
 */
export function reuseStable<T extends { id: string }>(prev: readonly T[], next: readonly T[], same: (old: T, n: T) => boolean): T[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  let allSame = prev.length === next.length;
  const out = next.map((n, i) => {
    const old = byId.get(n.id);
    if (old && same(old, n)) {
      if (prev[i] !== old) allSame = false;
      return old;
    }
    allSame = false;
    return n;
  });
  return allSame ? (prev as T[]) : out;
}
