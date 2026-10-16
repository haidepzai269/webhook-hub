import type { ProjectSummary } from "@/lib/hub/flow-project";
import type { ProjectStats } from "@/lib/hub/project-health";

/**
 * ⚠ DỮ LIỆU DEMO — CHỈ dùng khi mở `/projects?demo=1` (xem bố cục khi hub-api không chạy). KHÔNG phải dữ liệu thật, không
 * gọi API. Có đủ các trường thật (`stats` theo ADR-235) và đủ ba màu viền: xanh, đỏ (mỗi loại lý do), xám.
 * `usage` thật chỉ operator nhận; ở đây gắn cho vài dự án để thấy thanh dung lượng.
 */
const MB = 1024 * 1024;
const usage = (usedMb: number, quotaMb: number, level: string) => ({
  estimated: true as const,
  usedBytes: usedMb * MB,
  quotaBytes: quotaMb * MB,
  usedPct: Math.round((usedMb / quotaMb) * 100),
  level,
  quotaOverrideMb: null,
});

const stats = (createdAt: string, over: Partial<ProjectStats> = {}): ProjectStats => ({
  createdAt,
  sources: 2,
  endpoints: 2,
  members: 1,
  events24h: 0,
  failedAttempts24h: 0,
  dlq: 0,
  circuitOpen: 0,
  storageLevel: "OK",
  openAlerts: { critical: 0, warning: 0, info: 0 },
  ...over,
});

export const DEMO_PROJECTS: ProjectSummary[] = [
  {
    id: "demo-1",
    name: "Cafe Sài Gòn",
    slug: "cafe",
    environment: "live",
    role: "owner",
    usage: usage(212, 1024, "OK"),
    stats: stats("2026-09-20T02:00:00Z", {
      sources: 2,
      endpoints: 3,
      members: 3,
      events24h: 1284,
      failedAttempts24h: 4,
    }),
  },
  {
    id: "demo-2",
    name: "Bookstore",
    slug: "bookstore",
    environment: "test",
    role: "owner",
    usage: usage(860, 1024, "WARN_85"),
    stats: stats("2026-09-22T08:30:00Z", {
      sources: 1,
      endpoints: 2,
      members: 2,
      events24h: 342,
      failedAttempts24h: 37,
      dlq: 2,
    }),
  },
  {
    id: "demo-3",
    name: "Shop demo đồ án",
    slug: "shop",
    environment: "test",
    role: "owner",
    stats: stats("2026-09-18T01:00:00Z", { members: 1, events24h: 56 }),
  },
  {
    id: "demo-4",
    name: "PayOS sandbox",
    slug: "payos-sandbox",
    environment: "test",
    role: "developer",
    stats: stats("2026-10-02T04:00:00Z", {
      sources: 1,
      endpoints: 1,
      members: 4,
      events24h: 12,
      failedAttempts24h: 12,
      circuitOpen: 1,
    }),
  },
  {
    id: "demo-5",
    name: "Stripe checkout",
    slug: "stripe-checkout",
    environment: "live",
    role: "developer",
    usage: usage(1003, 1024, "CRITICAL_95"),
    stats: stats("2026-10-05T09:15:00Z", {
      sources: 1,
      endpoints: 2,
      members: 2,
      events24h: 2210,
      openAlerts: { critical: 0, warning: 1, info: 0 },
    }),
  },
  {
    id: "demo-6",
    name: "GitHub CI events",
    slug: "github-ci",
    environment: "test",
    role: "viewer",
    stats: stats("2026-10-08T03:00:00Z", { sources: 0, endpoints: 0, members: 5 }),
  },
  {
    id: "demo-7",
    name: "Kho hàng nội bộ",
    slug: "kho-noi-bo",
    environment: "live",
    role: "developer",
    stats: stats("2026-09-25T06:00:00Z", {
      sources: 3,
      endpoints: 1,
      members: 2,
      events24h: 0,
      storageLevel: "LOCKED",
    }),
  },
  {
    id: "demo-8",
    name: "Thông báo Zalo OA",
    slug: "zalo-notify",
    environment: "test",
    role: "viewer",
    stats: stats("2026-10-10T10:00:00Z", { sources: 1, endpoints: 0, events24h: 9 }),
  },
  {
    id: "demo-9",
    name: "Marketing automation",
    slug: "marketing-auto",
    environment: "test",
    role: "owner",
    usage: usage(37, 1024, "OK"),
    stats: stats("2026-10-12T02:00:00Z", { sources: 0, endpoints: 0 }),
  },
  {
    id: "demo-10",
    name: "Default (vận hành)",
    slug: "default",
    environment: "live",
    role: "owner",
    member: false,
    stats: stats("2026-09-17T00:00:00Z", { members: 0, events24h: 3 }),
  },
  { id: "demo-11", name: "Hoá đơn điện tử", slug: "e-invoice", environment: "live", role: "viewer", stats: null },
];

/** Dự án "mở gần nhất" giả lập cho demo. */
export const DEMO_CURRENT_ID = "demo-2";
