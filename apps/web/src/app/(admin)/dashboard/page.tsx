import { EventsChart } from "./_components/events-chart";
import { HealthCard } from "./_components/health-card";
import { KpiCards } from "./_components/kpi-cards";
import { RealtimeCard } from "./_components/realtime-card";
import { RecentEvents } from "./_components/recent-events";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <KpiCards />
      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <EventsChart />
        </div>
        <div className="flex min-w-0 flex-col gap-4 md:gap-6">
          <HealthCard />
          <RealtimeCard />
        </div>
      </div>
      <RecentEvents />
    </div>
  );
}
