"use client";

import { useEffect } from "react";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import { create } from "zustand";

import type { AlertChangedNotice } from "@/lib/alerts/types";
import { HUB_API_URL } from "@/lib/env";

import { emptyToastCursor, SOCKET_INVALIDATES, type ToastCursor } from "./ui-logic";
import { hubFetch } from "./client";
import { createRealtimeConnector, type RealtimeConnector, type RealtimeStatus } from "./realtime-connector";
import { currentProjectId, useProjectStore } from "./project-store";
import type { CircuitChangedNotice, DeliveryAttemptNotice, MetricsTick, TraceIngestedNotice } from "./types";

/** Payload `event.received` (khớp libs/common/src/types.ts EventReceivedNotice). */
export interface EventReceivedNotice {
  tenantId: string;
  correlationId: string;
  rawEventId: string;
  events: { id: string; type: string; source: string }[];
  deliveries: { deliveryId: string; eventId: string; destinationId: string; destinationName: string; destinationType: string }[];
}

const MAX_TICKS = 60; // 60 × 5s = 5 phút sparkline
const MAX_TRACES = 20;
const INVALIDATE_DEBOUNCE_MS = 400;

interface RealtimeState {
  /** ADR-242: ba mức — "connecting" (đang nối/nối lại, server có thể đang khởi động) chỉ thành "disconnected" sau ngưỡng. */
  status: RealtimeStatus;
  ticks: MetricsTick[];
  /** `trace.ingested` gần nhất (mới nhất ở đầu) — chặng ①–④ trong hub-api (S2-2). */
  traces: (TraceIngestedNotice & { receivedAt: number })[];
  /** Mốc toast của TraceFeed — ở store (không useRef) để mount lại không toast lại trace cũ (ADR-054). */
  toastCursor: ToastCursor<TraceIngestedNotice & { receivedAt: number }>;
}

export const useRealtimeStore = create<RealtimeState>(() => ({
  status: "connecting",
  ticks: [],
  traces: [],
  toastCursor: emptyToastCursor(),
}));

let socket: Socket | null = null;
let connector: RealtimeConnector | null = null;
let refCount = 0;

/** ADR-242: tab hiện lại / có mạng lại -> thử nối ngay (không chờ hết backoff). */
function subscribeWake(wake: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onVisible = () => {
    if (document.visibilityState === "visible") wake();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", wake);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", wake);
  };
}

/** Xin vé socket MỚI (60 giây) cho project đang chọn — mỗi lượt (re)connect một vé. */
function fetchSocketTicket(): Promise<string> {
  const projectId = realtimeProjectId();
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return hubFetch<{ ticket: string }>(`/auth/socket-ticket${q}`).then(({ ticket }) => ticket);
}

/**
 * Bus cục bộ trên CÙNG kết nối Socket.IO (không mở kết nối thứ hai): component nghe sự kiện thô
 * để vẽ hiệu ứng (chấm chạy trên V3, dòng log). Trạng thái thật vẫn đến từ API qua invalidate.
 */
export interface HubSocketEvents {
  "event.received": EventReceivedNotice;
  "delivery.attempt": DeliveryAttemptNotice;
  "circuit.changed": CircuitChangedNotice;
  "trace.ingested": TraceIngestedNotice;
  /** CB4: chỉ operator nhận (room `project:<id>:ops`), chỉ project đang mở; không có facts — chuông/banner gọi lại API. */
  "alert.changed": AlertChangedNotice;
}
type Listener<K extends keyof HubSocketEvents> = (payload: HubSocketEvents[K]) => void;
const listeners = new Map<keyof HubSocketEvents, Set<(payload: unknown) => void>>();

function emitLocal<K extends keyof HubSocketEvents>(name: K, payload: HubSocketEvents[K]) {
  for (const l of listeners.get(name) ?? []) {
    try {
      l(payload);
    } catch {
      /* hiệu ứng không bao giờ làm hỏng luồng realtime */
    }
  }
}

export function subscribeHubSocket<K extends keyof HubSocketEvents>(name: K, fn: Listener<K>): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  const l = fn as (payload: unknown) => void;
  set.add(l);
  return () => {
    set.delete(l);
  };
}

/**
 * Gom nhiều sự kiện socket trong một cửa sổ ngắn thành MỘT lượt invalidate — dưới tải (k6)
 * hub bắn hàng trăm `event.received`/giây, refetch theo từng cái sẽ tự DDoS chính hub-api.
 */
function createInvalidator(qc: QueryClient) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const invalidate = (...prefixes: string[]) => {
    for (const p of prefixes) pending.add(p);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const keys = [...pending];
      pending.clear();
      for (const k of keys) void qc.invalidateQueries({ queryKey: [k] });
    }, INVALIDATE_DEBOUNCE_MS);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending.clear();
  };
  return { invalidate, cancel };
}

/**
 * R-5: project mà realtime đang theo. Chỉ màn Event Flow đặt (khi mount, qua `useRealtimeProject`) và trả về
 * null khi rời màn — các trang khác của dashboard luôn theo tenant của JWT như trước.
 */
/** AU3: socket theo project đang chọn của TOÀN dashboard (project-store); đổi project -> xin vé mới, nối lại. */
function realtimeProjectId() {
  return currentProjectId();
}

/**
 * Giữ cho màn Event Flow (R-5): từ AU3 socket LUÔN theo project đang chọn của toàn dashboard (project-store),
 * nên hook này không còn việc gì — đổi project ở đâu cũng nối lại socket (xem `useHubRealtime`).
 */
export function useRealtimeProject(_projectId: string | null) {
  /* không còn việc gì — giữ chữ ký cho các màn đang gọi */
}

/**
 * Một kết nối Socket.IO dùng chung cho toàn admin (ref-count, mount ở layout dashboard).
 * Nhận sự kiện → invalidate query tương ứng, KHÔNG tự vá state bằng tay (nguồn sự thật là API).
 */
export function useHubRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    refCount++;
    if (!socket) {
      // SPEC-auth §5.7: mỗi lần (re)connect xin VÉ socket mới (60 giây) qua proxy của web — server kiểm quyền vào
      // project bằng CÙNG luật console (resolveProjectScope), rồi ký vé. ADR-242: xin vé lỗi tạm thời (cold start 502,
      // timeout, mạng) -> KHÔNG handshake vô vé (bị UNAUTHORIZED rồi Socket.IO không tự nối lại) mà tự thử lại có backoff;
      // 401 -> hubFetch tự đưa về /login. Trạng thái ba mức + vòng nối lại ở `realtime-connector.ts` (test được).
      // `autoConnect: false`: gắn listener trạng thái TRƯỚC lượt nối đầu.
      let c: RealtimeConnector | null = null;
      const created = io(HUB_API_URL, {
        transports: ["websocket"],
        autoConnect: false,
        auth: (cb) => c?.auth(cb),
      });
      c = createRealtimeConnector({
        socket: created,
        fetchTicket: fetchSocketTicket,
        onStatus: (status) => useRealtimeStore.setState({ status }),
        subscribeWake,
      });
      created.on("connect", c.handleConnect);
      created.on("disconnect", c.handleDisconnect);
      created.on("connect_error", c.handleConnectError);
      useRealtimeStore.setState({ status: c.status });
      socket = created;
      connector = c;
      created.connect();
    }
    const s = socket;
    const { invalidate, cancel } = createInvalidator(qc);
    // AU3: đổi project -> bỏ cache của project cũ (query key không mang projectId) + xin vé socket mới cho project mới.
    const unsubscribeProject = useProjectStore.subscribe((st, prev) => {
      if (st.projectId === prev.projectId) return;
      // L-6: trace của project trước không được hiện trên dải "Vừa nhận" của project mới.
      useRealtimeStore.setState({ traces: [], toastCursor: emptyToastCursor() });
      void qc.resetQueries();
      connector?.restart(); // vé mới cho project mới; lượt đang dở (vé project cũ) bị bỏ
    });

    // "flow" (SPEC-event-flow-ui): hành trình/danh sách/bản đồ gọi lại API — không tự ghép trạng thái.
    // R-5: phòng thủ phía client — payload của tenant khác project đang xem thì bỏ (không chấm chạy, không refetch).
    const foreign = (n: { tenantId?: string }) => {
      const p = realtimeProjectId();
      return Boolean(p && n.tenantId && n.tenantId !== p);
    };
    const onEvent = (n: EventReceivedNotice) => {
      if (foreign(n)) return;
      emitLocal("event.received", n);
      invalidate(...SOCKET_INVALIDATES["event.received"]);
    };
    // delivery.attempt (thay delivery.updated, S2-2): prefix "event" phủ cả sheet "Dấu vết" của đúng eventId.
    const onDelivery = (n: DeliveryAttemptNotice) => {
      if (foreign(n)) return;
      emitLocal("delivery.attempt", n);
      invalidate(...SOCKET_INVALIDATES["delivery.attempt"]);
    };
    const onCircuit = (n: CircuitChangedNotice) => {
      if (foreign(n)) return;
      emitLocal("circuit.changed", n);
      invalidate(...SOCKET_INVALIDATES["circuit.changed"]);
    };
    const onTrace = (n: TraceIngestedNotice) => {
      emitLocal("trace.ingested", n);
      if (n.outcome === "REJECTED") invalidate(...SOCKET_INVALIDATES["trace.rejected"]);
      useRealtimeStore.setState((st) => ({
        traces: [{ ...n, receivedAt: Date.now() }, ...st.traces].slice(0, MAX_TRACES),
      }));
    };
    // CB4: cảnh báo — bộ nhớ banner ghi nhận id (AlertNotifier nghe bus), rồi chuông + danh sách + nhận định gọi lại API.
    // Không lọc `foreign`: cảnh báo là xuyên project; server đã chỉ gửi cho operator.
    const onAlert = (n: AlertChangedNotice) => {
      emitLocal("alert.changed", n);
      invalidate(...SOCKET_INVALIDATES["alert.changed"]);
    };
    const onTick = (tick: MetricsTick) =>
      useRealtimeStore.setState((st) => ({ ticks: [...st.ticks, tick].slice(-MAX_TICKS) }));

    s.on("event.received", onEvent);
    s.on("delivery.attempt", onDelivery);
    s.on("circuit.changed", onCircuit);
    s.on("trace.ingested", onTrace);
    s.on("alert.changed", onAlert);
    s.on("metrics.tick", onTick);

    return () => {
      unsubscribeProject();
      cancel();
      s.off("event.received", onEvent);
      s.off("delivery.attempt", onDelivery);
      s.off("circuit.changed", onCircuit);
      s.off("trace.ingested", onTrace);
      s.off("alert.changed", onAlert);
      s.off("metrics.tick", onTick);
      refCount--;
      if (refCount === 0) {
        // ADR-242: gỡ timer backoff/ngưỡng đỏ + listener visibility/online TRƯỚC khi ngắt (không rò sau logout/unmount).
        connector?.dispose();
        connector = null;
        s.disconnect();
        s.removeAllListeners();
        socket = null;
        useRealtimeStore.setState({ status: "connecting", ticks: [], traces: [] });
      }
    };
  }, [qc]);
}
