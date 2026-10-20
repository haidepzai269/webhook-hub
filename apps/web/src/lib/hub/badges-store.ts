"use client";

import { useEffect, useRef } from "react";

import { usePathname } from "next/navigation";

import { create } from "zustand";

import {
  addLive,
  applyServer,
  BADGE_TABS,
  type BadgeState,
  type BadgesResponse,
  type BadgeTab,
  badgeTabOfPath,
  claimId,
  emptyBadges,
  markSeen,
  rememberIds,
  rememberName,
  resetBadges,
} from "./badges-logic";
import { armSeenWrites, readSeen, writeSeen } from "./badges-seen";
import { hubFetch } from "./client";
import { useMeId, useMeStore } from "./me-store";
import { useProjectStore } from "./project-store";
import { subscribeHubSocket } from "./socket";

/** Badge sidebar (ADR-269). Chỉ giữ đếm kẹp + một bản ghi mới nhất mỗi tab — không giữ danh sách. */
export const useBadgeStore = create<{ badges: BadgeState }>(() => ({ badges: emptyBadges() }));

const FLUSH_MS = 500; // gom cập nhật socket: cộng vào biến thường, đẩy state mỗi ~500ms
const POLL_MS = 30_000; // lưới an toàn (bù đường DEAD không phát socket, socket rớt)

/**
 * Gắn MỘT lần ở AppSidebar. Lúc load (và mỗi 30s, và khi vào/rời tab) gọi `GET /api/v1/badges`; giữa hai lần cộng dồn từ
 * `subscribeHubSocket` (không thêm kết nối, không thêm PUBLISH — worker không đổi). Đang đứng ở tab thì tab đó không tăng;
 * vào/rời tab -> đặt mốc last-seen = `cursor` server trả (events: seq lớn nhất; còn lại: thời điểm µs) và badge về 0.
 */
export function useSidebarBadges(): void {
  const userId = useMeId();
  const projectId = useProjectStore((s) => s.projectId);
  const pathname = usePathname();
  const tab = badgeTabOfPath(pathname);
  const tabRef = useRef<BadgeTab | null>(tab);
  const prevTabRef = useRef<BadgeTab | null>(null);
  const refreshRef = useRef<((mark: BadgeTab[]) => void) | null>(null);
  tabRef.current = tab;

  useEffect(() => {
    if (!userId || !projectId) return;
    let alive = true;
    const seen: Partial<Record<BadgeTab, string>> = {};
    for (const t of BADGE_TABS) {
      const v = readSeen(userId, projectId, t);
      if (v) seen[t] = v;
    }
    armSeenWrites();
    useBadgeStore.setState({ badges: resetBadges() });
    // Id đã được tính theo từng tab (từ poll lẫn socket) — chống đếm đôi khi socket báo lại bản ghi poll đã đếm.
    const counted: Record<BadgeTab, Set<string>> = { events: new Set(), deliveries: new Set(), dlq: new Set() };
    const stillMe = () => useMeStore.getState().me?.user.id === userId;
    const names = new Map<string, string>();
    const acc = { events: 0, deliveries: 0, dlq: 0 };
    const pend: {
      events: BadgeState["latest"]["events"];
      deliveries: BadgeState["latest"]["deliveries"];
      dlq: BadgeState["latest"]["dlq"];
    } = {
      events: null,
      deliveries: null,
      dlq: null,
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    const queued = new Set<BadgeTab>(); // vào/rời tab lúc đang có lượt gọi dở: chạy lại ngay sau đó, không mất đánh dấu

    const flush = () => {
      timer = null;
      if (!alive) return;
      let s = useBadgeStore.getState().badges;
      if (acc.events > 0) s = addLive(s, "events", acc.events, pend.events, tabRef.current);
      if (acc.deliveries > 0) s = addLive(s, "deliveries", acc.deliveries, pend.deliveries, tabRef.current);
      if (acc.dlq > 0) s = addLive(s, "dlq", acc.dlq, pend.dlq, tabRef.current);
      acc.events = acc.deliveries = acc.dlq = 0;
      useBadgeStore.setState({ badges: s });
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    };
    const nameOf = (id: string) => names.get(id) ?? `${id.slice(0, 8)}…`;

    const refresh = async (mark: BadgeTab[]) => {
      if (!alive) return;
      if (inflight) {
        for (const t of mark) queued.add(t);
        return;
      }
      inflight = true;
      try {
        const q = new URLSearchParams();
        for (const t of BADGE_TABS) q.set(t, seen[t] ?? "head");
        const r = await hubFetch<BadgesResponse>(`/api/v1/badges?${q.toString()}`);
        if (!alive) return;
        const cur = tabRef.current;
        // Mốc: tab chưa có -> mốc hiện tại của server; tab vừa vào/rời/đang mở -> đẩy tới bản ghi mới nhất đã thấy.
        const advance = new Set<BadgeTab>([...mark, ...(cur ? [cur] : [])]);
        for (const t of BADGE_TABS) {
          const c = r[t].cursor;
          if (!c) continue;
          if (!seen[t] || advance.has(t)) {
            seen[t] = c;
            if (alive && stillMe()) writeSeen(userId, projectId, t, c); // đã đăng xuất / đổi user -> không ghi lại hub:seen:*
          }
          rememberIds(counted[t], r[t].ids);
        }
        acc.events = acc.deliveries = acc.dlq = 0; // server là nguồn sự thật cho lượt này
        let s = applyServer(useBadgeStore.getState().badges, r, cur);
        for (const t of mark) s = markSeen(s, t);
        useBadgeStore.setState({ badges: s });
      } catch {
        /* lần sau thử lại — badge chỉ là tiện ích */
      } finally {
        inflight = false;
        if (queued.size > 0 && alive) {
          const again = [...queued];
          queued.clear();
          void refresh(again);
        }
      }
    };
    refreshRef.current = (m) => void refresh(m);
    void refresh(tabRef.current ? [tabRef.current] : []);

    const offEvent = subscribeHubSocket("event.received", (n) => {
      if (n.tenantId && n.tenantId !== projectId) return; // phòng thủ: chỉ project đang xem
      for (const d of n.deliveries ?? []) rememberName(names, d.destinationId, d.destinationName);
      const fresh = n.events.filter((e) => claimId(counted.events, e.id));
      const last = fresh[fresh.length - 1];
      if (!last) return;
      acc.events += fresh.length;
      pend.events = { type: last.type, source: last.source, at: new Date().toISOString() };
      schedule();
    });
    const offDelivery = subscribeHubSocket("delivery.attempt", (n) => {
      if (n.tenantId && n.tenantId !== projectId) return;
      const at = new Date().toISOString();
      if (n.attemptNo === 1 && claimId(counted.deliveries, n.deliveryId)) {
        acc.deliveries += 1;
        pend.deliveries = { destination: nameOf(n.destinationId), status: n.status, at };
      }
      if (n.status === "DEAD" && claimId(counted.dlq, n.deliveryId)) {
        acc.dlq += 1;
        pend.dlq = { destination: nameOf(n.destinationId), attemptNo: n.attemptNo, at };
      }
      schedule();
    });
    const poll = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void refresh([]);
    }, POLL_MS);

    // Tab hiện lại sau khi ẩn: nạp ngay thay vì chờ nhịp 30s.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh([]);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      alive = false;
      refreshRef.current = null;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      offEvent();
      offDelivery();
      useBadgeStore.setState({ badges: resetBadges() });
    };
  }, [userId, projectId]);

  // Vào / rời tab có badge: đánh dấu đã xem cả tab vừa rời (những gì đến lúc đang xem) lẫn tab mới vào.
  useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (prev === tab) return;
    const mark = [prev, tab].filter((t): t is BadgeTab => t !== null);
    if (tab) useBadgeStore.setState((s) => ({ badges: markSeen(s.badges, tab) }));
    if (mark.length > 0) refreshRef.current?.(mark);
  }, [tab]);
}
