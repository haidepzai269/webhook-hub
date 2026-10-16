import { EventsChart } from "./_components/events-chart";
import { InsightsCard } from "./_components/insights-card";
import { KpiCards } from "./_components/kpi-cards";
import { RealtimeCard } from "./_components/realtime-card";
import { RecentEvents } from "./_components/recent-events";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <KpiCards />
      <InsightsCard />
      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <EventsChart />
        </div>
        {/* ADR-241: bỏ thẻ "Sức khoẻ hệ thống" — RealtimeCard đứng một mình, giãn theo chiều cao biểu đồ. */}
        <div className="min-w-0">
          <RealtimeCard />
        </div>
      </div>
      <RecentEvents />
    </div>
  );
}
