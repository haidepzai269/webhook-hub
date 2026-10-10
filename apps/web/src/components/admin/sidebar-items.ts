import {
  Activity,
  Cable,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
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
    id: "overview",
    label: "Tổng quan",
    items: [{ id: "dashboard", title: "Dashboard", url: "/dashboard", icon: LayoutDashboard }],
  },
  {
    id: "flow",
    label: "Luồng dữ liệu",
    items: [
      { id: "events", title: "Sự kiện", url: "/dashboard/events", icon: Activity },
      { id: "deliveries", title: "Giao hàng (Deliveries)", url: "/dashboard/deliveries", icon: Send },
      { id: "dlq", title: "DLQ", url: "/dashboard/dlq", icon: Skull },
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
