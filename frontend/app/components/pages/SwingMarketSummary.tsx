import { numberText, type ResearchPackage } from "../../lib/swing-research";

export function SwingMarketSummary({ data }: { data: ResearchPackage }) {
  const breadth = data.breadth;
  return <section aria-label="Completed-session market conditions" className="rounded-xl border border-card-border bg-card p-5 space-y-4">
    <div className="flex flex-wrap justify-between gap-3">
      <h2 className="text-lg font-semibold text-text-heading">Market conditions · {data.universe} · {data.session}</h2>
      <span className="text-sm text-muted">{data.state.toUpperCase()} · {breadth.available}/{breadth.requested} source bars available</span>
    </div>
    <p className="text-sm text-muted">{data.membership_basis}. Planning only. No live execution readiness is inferred.</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {breadth.gauges.map(g => <div key={g.label} className="rounded-lg border border-card-border p-3">
        <div className="text-sm text-muted">Above {g.label}</div>
        <strong className="block text-xl text-text-heading">{g.value == null ? "Unknown" : `${numberText(g.value, 1)}%`}</strong>
        <div className="text-xs text-muted">{g.above} above / {g.eligible} eligible / {breadth.requested} requested</div>
      </div>)}
    </div>
    <p className="text-sm text-text-heading">Advances {breadth.advances} · Declines {breadth.declines} · Daily eligible {breadth.daily_eligible}. Up 20% in five sessions: {numberText(breadth.up20_in5, 0)} / {breadth.five_day_eligible} eligible. Close at 252-session high: {numberText(breadth.new_highs, 0)} / {breadth.extremes_eligible} eligible.</p>
  </section>;
}
