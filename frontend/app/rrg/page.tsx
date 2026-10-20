import { PageHeader } from "../components/layout/PageHeader";
import { RRGDashboard } from "./components/RRGDashboard";

// Force dynamic — every control change in the dashboard re-fetches data
// from Supabase client-side. SSR caching here would just stale immediately.
export const dynamic = "force-dynamic";

export default function RRGPage() {
  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader eyebrow="Relative strength" title="Relative rotation" description="38 NSE sector and thematic indices. Compare four benchmarks, timeframes and historical trails." />
      <RRGDashboard />
    </div>
  );
}
