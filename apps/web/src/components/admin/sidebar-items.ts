import {
  Activity,
  BellRing,
  Cable,
  FlaskConical,
  FolderKanban,
  Inbox,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Network,
  ScrollText,
  Send,
  Skull,
  Workflow,
} from "lucide-react";

import type { MessageKey } from "@/lib/i18n/dictionary";

/**
 * Nhãn KHÔNG nằm ở đây — chỉ khoá dịch (`@/lib/i18n/dictionary`), theo quy ước `nav.item.<id>` / `nav.group.<id>`.
 * Đổi chữ hiển thị = sửa từ điển (cả vi lẫn en); `id`/`url` giữ nguyên.
 */
export interface NavItem {
  id: string;
  titleKey: MessageKey;
  url: string;
  icon: LucideIcon;
  /** CB4: chỉ người vận hành hub thấy (vd. Cảnh báo — API `/alerts*` trả 403 operator_required cho người khác). */
  operatorOnly?: boolean;
}

export interface NavGroup {
  id: string;
  labelKey: MessageKey;
  items: NavItem[];
}

export const sidebarItems: NavGroup[] = [
  {
    id: "flow",
    labelKey: "nav.group.flow",
    items: [
      // SPEC-event-flow-ui V3: màn đầu tiên — nhìn là biết luồng nào chạy, luồng nào crash.
      { id: "flow-map", titleKey: "nav.item.flow-map", url: "/dashboard/flow", icon: Network },
      { id: "events", titleKey: "nav.item.events", url: "/dashboard/events", icon: Activity },
      { id: "deliveries", titleKey: "nav.item.deliveries", url: "/dashboard/deliveries", icon: Send },
      { id: "dlq", titleKey: "nav.item.dlq", url: "/dashboard/dlq", icon: Skull },
    ],
  },
  {
    id: "overview",
    labelKey: "nav.group.overview",
    items: [
      { id: "dashboard", titleKey: "nav.item.dashboard", url: "/dashboard", icon: LayoutDashboard },
      // CB4 (SPEC-canh-bao-nhan-dinh §8.4): cảnh báo xuyên project — chỉ operator.
      { id: "alerts", titleKey: "nav.item.alerts", url: "/dashboard/alerts", icon: BellRing, operatorOnly: true },
    ],
  },
  {
    id: "project",
    labelKey: "nav.group.project",
    items: [
      // SK1 (SPEC-shop-ket-noi-project §3): tạo project + API key (copy connection string một lần).
      { id: "projects", titleKey: "nav.item.projects", url: "/dashboard/projects", icon: FolderKanban },
      { id: "api-keys", titleKey: "nav.item.api-keys", url: "/dashboard/api-keys", icon: KeyRound },
    ],
  },
  {
    id: "config",
    labelKey: "nav.group.config",
    items: [
      { id: "sources", titleKey: "nav.item.sources", url: "/dashboard/sources", icon: Inbox },
      { id: "destinations", titleKey: "nav.item.destinations", url: "/dashboard/destinations", icon: Cable },
      { id: "subscriptions", titleKey: "nav.item.subscriptions", url: "/dashboard/subscriptions", icon: Workflow },
    ],
  },
  {
    id: "tools",
    labelKey: "nav.group.tools",
    items: [
      { id: "playground", titleKey: "nav.item.playground", url: "/dashboard/playground", icon: FlaskConical },
      { id: "audit", titleKey: "nav.item.audit", url: "/dashboard/audit", icon: ScrollText },
    ],
  },
];
