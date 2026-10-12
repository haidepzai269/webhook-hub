"use client";

import { useEffect, useRef } from "react";

import { toast } from "sonner";

import { primaryHref } from "@/lib/alerts/links";
import {
  bannerAdd,
  bannerExpire,
  bannerNextExpiry,
  bannerResolve,
  bannerSync,
  noteSocketNotice,
  routeArrival,
  takeArrivals,
  toastsToDismiss,
} from "@/lib/alerts/notify-logic";
import { useOpenAlertFeed, useSubjectNames } from "@/lib/hub/alert-queries";
import { useIsOperator } from "@/lib/hub/me-store";
import { subscribeHubSocket } from "@/lib/hub/socket";
import { useT } from "@/lib/i18n/use-t";

import { showAlertToast } from "./alert-toast";
import { useAlertText, useAlertUiStore, useOpenAlertTarget } from "./alert-ui";

/**
 * CB4: "bộ não" banner/toast của phiên — không vẽ gì. Mount MỘT lần ở layout dashboard (chỉ operator).
 *  1. Nghe `alert.changed` (bus của socket.ts): OPEN -> nhớ id (được bật banner); RESOLVED -> banner đang hiện đổi xanh.
 *     socket.ts tự gọi lại các query "alerts".
 *  2. Mỗi lần danh sách OPEN về (poll 30s / sau alert.changed): `takeArrivals` (lần đầu = mốc, không báo gì) ->
 *     `routeArrival` -> banner hoặc toast. Đồng thời `bannerSync` (đã xem ở nơi khác / đã đóng khi socket không thấy).
 * Toàn bộ quyết định là hàm thuần ở lib/alerts/notify-logic.ts (test CB:T15).
 */
export function AlertNotifier() {
  const operator = useIsOperator();
  const feed = useOpenAlertFeed();
  const setBanner = useAlertUiStore((s) => s.setBanner);
  const nextExpiry = useAlertUiStore((s) => bannerNextExpiry(s.banner));
  const text = useAlertText();
  const t = useT();
  const open = useOpenAlertTarget();
  const nameOf = useSubjectNames(feed.data?.items, operator);
  // Hàm dựng câu/tên đổi danh tính theo ngôn ngữ — để trong ref, effect xử lý dữ liệu không chạy lại vì chúng.
  const deps = useRef({ text, t, open, nameOf });
  deps.current = { text, t, open, nameOf };

  useEffect(() => {
    if (!operator) return;
    return subscribeHubSocket("alert.changed", (n) => {
      const { mem } = useAlertUiStore.getState();
      noteSocketNotice(mem, n);
      if (n.state === "RESOLVED") setBanner((b) => bannerResolve(b, n.id, Date.now()));
    });
  }, [operator, setBanner]);

  const data = feed.data;
  useEffect(() => {
    if (!operator || !data) return;
    const { mem } = useAlertUiStore.getState();
    const now = Date.now();
    const complete = data.next === null;
    setBanner((b) => bannerSync(b, data.items, complete, now));
    // Review L4: toast của cảnh báo đã "Đã xem" hoặc đã đóng thì gỡ (toast critical dính không treo mãi).
    for (const id of toastsToDismiss(mem, data.items, complete)) toast.dismiss(`alert-${id}`);
    for (const a of takeArrivals(mem, data.items, now)) {
      const route = routeArrival(a, mem);
      if (route.kind === "banner") {
        setBanner((b) => bannerAdd(b, a));
      } else if (route.kind === "toast") {
        const { text: build, t: tr, open: go, nameOf: names } = deps.current;
        const msg = build(a, names(a.subjectId));
        mem.toasted.add(a.id);
        showAlertToast(a.id, route.durationMs, {
          severity: a.severity,
          severityLabel: tr(`alerts.severity.${a.severity}`),
          projectName: a.project.name,
          title: msg.headline,
          description: msg.message || msg.fix,
          viewLabel: tr("alerts.toast.view"),
          dismissLabel: tr("alerts.toast.dismiss"),
          onView: () => go(a.project.id, primaryHref(a)),
        });
      }
    }
  }, [operator, data, setBanner]);

  // Banner xanh "Đã ổn trở lại" giữ 4s rồi thu lại. Review TB2: hẹn theo HẠN SỚM NHẤT; thu xong hạn đổi -> hẹn lại.
  useEffect(() => {
    if (nextExpiry === null) return;
    const id = setTimeout(() => setBanner((b) => bannerExpire(b, Date.now())), Math.max(0, nextExpiry - Date.now()) + 20);
    return () => clearTimeout(id);
  }, [nextExpiry, setBanner]);

  return null;
}
