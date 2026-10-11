import {
  Activity,
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

export interface NavItem {
  id: string;
  title: string;
  url: string;
  icon: LucideIcon;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const sidebarItems: NavGroup[] = [
  {
    id: "flow",
    label: "Luồng dữ liệu",
    items: [
      // SPEC-event-flow-ui V3: màn đầu tiên — nhìn là biết luồng nào chạy, luồng nào crash.
      { id: "flow-map", title: "Bản đồ luồng", url: "/dashboard/flow", icon: Network },
      { id: "events", title: "Hành trình sự kiện", url: "/dashboard/events", icon: Activity },
      { id: "deliveries", title: "Giao hàng (Deliveries)", url: "/dashboard/deliveries", icon: Send },
      { id: "dlq", title: "DLQ", url: "/dashboard/dlq", icon: Skull },
    ],
  },
  {
    id: "overview",
    label: "Tổng quan",
    items: [{ id: "dashboard", title: "Dashboard", url: "/dashboard", icon: LayoutDashboard }],
  },
  {
    id: "project",
    label: "Project",
    items: [
      // SK1 (SPEC-shop-ket-noi-project §3): tạo project + API key (copy connection string một lần).
      { id: "projects", title: "Project", url: "/dashboard/projects", icon: FolderKanban },
      { id: "api-keys", title: "API key", url: "/dashboard/api-keys", icon: KeyRound },
    ],
  },
  {
    id: "config",
    label: "Cấu hình",
    items: [
      { id: "sources", title: "Nguồn (Sources)", url: "/dashboard/sources", icon: Inbox },
      { id: "destinations", title: "Đích (Destinations)", url: "/dashboard/destinations", icon: Cable },
      { id: "subscriptions", title: "Subscriptions", url: "/dashboard/subscriptions", icon: Workflow },
    ],
  },
  {
    id: "tools",
    label: "Công cụ",
    items: [
      { id: "playground", title: "Playground", url: "/dashboard/playground", icon: FlaskConical },
      { id: "audit", title: "Nhật ký (Audit)", url: "/dashboard/audit", icon: ScrollText },
    ],
  },
];
