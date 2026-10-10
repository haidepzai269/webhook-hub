"use client";

import { useEffect } from "react";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import { create } from "zustand";

import { HUB_API_URL } from "@/lib/env";

import { emptyToastCursor, type ToastCursor } from "./ui-logic";
import { getToken } from "./token";
import type { CircuitChangedNotice, DeliveryAttemptNotice, MetricsTick, TraceIngestedNotice } from "./types";

const MAX_TICKS = 60; // 60 × 5s = 5 phút sparkline
const MAX_TRACES = 20;
const INVALIDATE_DEBOUNCE_MS = 400;

interface RealtimeState {
  connected: boolean;
  ticks: MetricsTick[];
  /** `trace.ingested` gần nhất (mới nhất ở đầu) — chặng ①–④ trong hub-api (S2-2). */
  traces: (TraceIngestedNotice & { receivedAt: number })[];
  /** Mốc toast của TraceFeed — ở store (không useRef) để mount lại không toast lại trace cũ (ADR-054). */
  toastCursor: ToastCursor<TraceIngestedNotice & { receivedAt: number }>;
}

export const useRealtimeStore = create<RealtimeState>(() => ({
  connected: false,
  ticks: [],
  traces: [],
  toastCursor: emptyToastCursor(),
}));

let socket: Socket | null = null;
let refCount = 0;

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
 * Một kết nối Socket.IO dùng chung cho toàn admin (ref-count, mount ở layout dashboard).
 * Nhận sự kiện → invalidate query tương ứng, KHÔNG tự vá state bằng tay (nguồn sự thật là API).
 */
export function useHubRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    refCount++;
    if (!socket) {
      // auth dạng callback: mỗi lần (re)connect đọc token MỚI NHẤT (đăng nhập lại không cần reload).
      // Hub từ chối handshake thiếu/sai JWT (connect_error "UNAUTHORIZED") -> badge Socket tắt;
      // việc đưa về /auth/login do hubFetch xử lý khi API trả 401.
      socket = io(HUB_API_URL, { transports: ["websocket"], auth: (cb) => cb({ token: getToken() }) });
    }
    const s = socket;
    const { invalidate, cancel } = createInvalidator(qc);

    const onConnect = () => useRealtimeStore.setState({ connected: true });
    const onDisconnect = () => useRealtimeStore.setState({ connected: false });
    const onEvent = () => invalidate("overview", "events", "timeseries");
    // delivery.attempt (thay delivery.updated, S2-2): prefix "event" phủ cả sheet "Dấu vết" của đúng eventId.
    const onDelivery = (_n: DeliveryAttemptNotice) =>
      invalidate("overview", "deliveries", "dlq", "timeseries", "event", "events");
    const onCircuit = (_n: CircuitChangedNotice) => invalidate("destinations");
    const onTrace = (n: TraceIngestedNotice) =>
      useRealtimeStore.setState((st) => ({
        traces: [{ ...n, receivedAt: Date.now() }, ...st.traces].slice(0, MAX_TRACES),
      }));
    const onTick = (tick: MetricsTick) =>
      useRealtimeStore.setState((st) => ({ ticks: [...st.ticks, tick].slice(-MAX_TICKS) }));

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("event.received", onEvent);
    s.on("delivery.attempt", onDelivery);
    s.on("circuit.changed", onCircuit);
    s.on("trace.ingested", onTrace);
    s.on("metrics.tick", onTick);
    useRealtimeStore.setState({ connected: s.connected });

    return () => {
      cancel();
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("event.received", onEvent);
      s.off("delivery.attempt", onDelivery);
      s.off("circuit.changed", onCircuit);
      s.off("trace.ingested", onTrace);
      s.off("metrics.tick", onTick);
      refCount--;
      if (refCount === 0) {
        s.disconnect();
        socket = null;
        useRealtimeStore.setState({ connected: false, ticks: [], traces: [] });
      }
    };
  }, [qc]);
}
