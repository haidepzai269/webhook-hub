/**
 * CB4 (§8.1, §8.4): deep link của cảnh báo — trang + bộ lọc đúng đối tượng TRONG project của cảnh báo. Bấm vào thì
 * console đổi sang project đó trước (project-store) rồi mở link; bộ lọc trên URL theo list-url.ts (ADR-163).
 * TS thuần để jest test thẳng.
 */
import type { MessageKey } from "../i18n/dictionary";

export interface AlertAction {
  labelKey: MessageKey;
  href: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function q(path: string, params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  p.sort();
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Các hành động của một cảnh báo, hành động CHÍNH đứng đầu (banner hiện tối đa 2, chuông/toast dùng cái đầu).
 * Đối tượng không phải UUID (dữ liệu lạ) -> link trang không lọc, không ghép chuỗi lạ vào URL.
 */
export function alertActions(a: { rule: string; subjectId: string; facts?: Record<string, unknown> | null }): AlertAction[] {
  const id = UUID.test(a.subjectId) ? a.subjectId : null;
  const status = a.facts?.httpStatus;
  const code = typeof status === "number" && status >= 100 && status <= 599 ? String(status) : null;
  switch (a.rule) {
    case "destination.auth_rejected":
      return [
        { labelKey: "alerts.action.view-deliveries", href: q("/dashboard/deliveries", { destination: id, code: code ?? "4xx" }) },
        { labelKey: "alerts.action.check-destination", href: "/dashboard/destinations" },
        { labelKey: "alerts.action.open-dlq", href: q("/dashboard/dlq", { destination: id, errorKind: "http_4xx" }) },
      ];
    case "destination.client_error":
      return [
        { labelKey: "alerts.action.view-deliveries", href: q("/dashboard/deliveries", { destination: id, code: code ?? "4xx" }) },
        { labelKey: "alerts.action.check-destination", href: "/dashboard/destinations" },
      ];
    case "destination.failing":
      return [
        { labelKey: "alerts.action.view-deliveries", href: q("/dashboard/deliveries", { destination: id, status: "RETRYING" }) },
        { labelKey: "alerts.action.check-destination", href: "/dashboard/destinations" },
      ];
    case "destination.circuit_open":
      return [
        { labelKey: "alerts.action.check-destination", href: "/dashboard/destinations" },
        { labelKey: "alerts.action.view-deliveries", href: q("/dashboard/deliveries", { destination: id }) },
      ];
    case "delivery.dead_spike":
      return [{ labelKey: "alerts.action.open-dlq", href: q("/dashboard/dlq", { age: "1h" }) }];
    case "source.signature_failing":
      return [
        { labelKey: "alerts.action.view-rejected", href: q("/dashboard/events", { source: id, status: "rejected" }) },
        { labelKey: "alerts.action.open-sources", href: "/dashboard/sources" },
      ];
    case "source.connection_broken":
      return [{ labelKey: "alerts.action.open-sources", href: "/dashboard/sources" }];
    case "source.silent":
      return [
        { labelKey: "alerts.action.view-source-events", href: q("/dashboard/events", { source: id }) },
        { labelKey: "alerts.action.open-sources", href: "/dashboard/sources" },
      ];
    case "normalize.backlog":
      return [{ labelKey: "alerts.action.renormalize", href: "/dashboard/events" }];
    // QT6 (§9): cảnh báo dung lượng -> trang Dung lượng của project (LOCKED: "Dọn theo gợi ý" lên đầu).
    case "project.storage_warn":
    case "project.storage_critical":
      return [{ labelKey: "alerts.action.open-storage", href: "/dashboard/storage" }];
    case "project.storage_locked":
      return [
        { labelKey: "alerts.action.clean-suggested", href: "/dashboard/storage#suggestions" },
        { labelKey: "alerts.action.open-storage", href: "/dashboard/storage" },
      ];
    case "hub.storage_near_full":
      return [{ labelKey: "alerts.action.open-projects", href: "/dashboard/projects" }];
    default:
      return [];
  }
}

/** Link chính (chuông, toast "Xem"): hành động đầu, không có thì trang Cảnh báo lọc đúng project. */
export function primaryHref(a: { rule: string; subjectId: string; facts?: Record<string, unknown> | null; project: { id: string } }): string {
  return alertActions(a)[0]?.href ?? q("/dashboard/alerts", { project: a.project.id });
}
