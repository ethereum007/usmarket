export type DailyBar = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type Breadth = {
  requested: number; available: number; daily_eligible: number; advances: number; declines: number;
  advance_pct: number | null; five_day_eligible: number; up20_in5: number | null; up30_in5: number | null;
  extremes_eligible: number; new_highs: number | null; new_lows: number | null;
  gauges: { label: string; eligible: number; above: number; value: number | null }[];
};
export type ResearchSetup = {
  symbol: string; strategy: string; signal: "BULL" | "BEAR"; setup_id: string; setup_version: string;
  source_snapshot_id: string; session: string; entry_price: number; breakout_level: number;
  stop_loss: number; target: number; strength: number; lifecycle_state: string; notes: string;
  reasons: string[]; research_warnings: string[]; benchmark_rs_20: number | null; benchmark_rs_60: number | null;
  target_policy: string;
};
export type ResearchPackage = {
  id: string; session: string; state: "final" | "partial"; universe: string; version: string;
  published_at: string; membership_basis: string; source_snapshot_id: string;
  breadth: Breadth; symbols: string[]; missing_symbols: string[]; unclassified_symbols: string[];
  industry_taxonomy: string; setups: ResearchSetup[]; source_bars: Record<string, DailyBar[]>;
  groups: { name: string; classification: string; members: string[]; breadth: Breadth;
    mean_excess_return20: number | null; rs20_eligible: number; setup_symbols: string[] }[];
};
export type ResearchResponse = { success: boolean; package: ResearchPackage | null; has_final: boolean; last_attempt?: ResearchPackage | null };
export type ConditionalPlan = {
  id: string; revision: number; package_id: string; setup_version: string; setup_id: string;
  symbol: string; direction: "BULL" | "BEAR"; session: string; trigger: number; stop: number; expiry: string;
  exit_policy: string; notes: string; state: "draft" | "planned" | "cancelled" | "invalidated" | "expired";
  capital: number; risk_pct: number; allocation_cap_pct: number; quantity: number;
  earnings_state: "unknown" | "checked_no_event" | "event_nearby"; event_risk: string; alert_state: string;
};
export const numberText = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? "Unknown" : value.toLocaleString("en-IN", { maximumFractionDigits: digits });

/** Aggregate only observed bars. An incomplete last week stays labelled by its last observed session. */
export function weeklyBars(bars: DailyBar[]): DailyBar[] {
  const groups = new Map<string, DailyBar>();
  for (const bar of bars) {
    const day = new Date(`${bar.date}T00:00:00Z`);
    const weekday = day.getUTCDay();
    day.setUTCDate(day.getUTCDate() - ((weekday + 6) % 7));
    const key = day.toISOString().slice(0, 10);
    const prior = groups.get(key);
    groups.set(key, prior ? { date: bar.date, open: prior.open, high: Math.max(prior.high, bar.high),
      low: Math.min(prior.low, bar.low), close: bar.close, volume: prior.volume + bar.volume } : { ...bar });
  }
  return [...groups.values()];
}
