import { PageHeader } from "@/components/admin/page-header";
import { getT } from "@/lib/i18n/server";
import { EventsChart } from "./_components/events-chart";
import { InsightsCard } from "./_components/insights-card";
import { KpiCards } from "./_components/kpi-cards";
import { RealtimeCard } from "./_components/realtime-card";
import { RecentEvents } from "./_components/recent-events";

export default async function DashboardPage() {
  const t = await getT();
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <PageHeader className="mb-0" title={t("nav.item.dashboard")} description={t("page.dashboard.description")} />
      <KpiCards />
      <InsightsCard />
      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <EventsChart />
        </div>
        {/* ADR-242: bỏ thẻ "Sức khoẻ hệ thống" — RealtimeCard đứng một mình, giãn theo chiều cao biểu đồ. */}
        <div className="min-w-0">
          <RealtimeCard />
        </div>
      </div>
      <RecentEvents />
    </div>
  );
}
