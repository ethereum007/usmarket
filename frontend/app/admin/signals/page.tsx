"use client";

import { PageHeader } from "../../components/layout/PageHeader";

import { useEffect, useMemo, useState } from "react";
import { fetchAPI } from "../../lib/api";
import { cn } from "../../lib/utils";

const HORIZONS = ["15m", "1h", "eod", "next_day_eod"] as const;
type Horizon = (typeof HORIZONS)[number];

interface HorizonStats {
  total: number;
  resolved: number;
  pending: number;
  wins: number;
  losses: number;
  flats: number;
  win_rate: number | null;
  win_rate_excl_flat: number | null;
  avg_return_pct: number | null;
  avg_mfe_pct: number | null;
  avg_mae_pct: number | null;
}

interface StatsResponse {
  success: boolean;
  as_of: string;
  days: number;
  by_signal_type: Record<string, Partial<Record<Horizon, HorizonStats>>>;
}

interface SignalFire {
  id: string;
  signal_type: string;
  symbol: string;
  category: string | null;
  fired_at: string;
  trigger_price: number | null;
  strength: number | null;
  direction: string | null;
  confidence: string | null;
  metadata: Record<string, any> | null;
  context: Record<string, any> | null;
  signal_outcomes?: Array<{
    horizon: string;
    status: string;
    return_pct: number | null;
    mfe_pct: number | null;
    mae_pct: number | null;
  }>;
}

interface FiresResponse {
  success: boolean;
  count: number;
  fires: SignalFire[];
}

export default function AdminSignalsPage() {
  const [days, setDays] = useState(15);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [fires, setFires] = useState<SignalFire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>("");
  const [filterSymbol, setFilterSymbol] = useState<string>("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, firesRes] = await Promise.all([
        fetchAPI(`/api/admin/signal-stats?days=${days}`),
        fetchAPI(`/api/admin/signal-fires?days=${days}&limit=200`),
      ]);
      setStats(statsRes);
      setFires((firesRes as FiresResponse).fires || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [days]);

  const signalTypes = useMemo(() => {
    if (!stats) return [];
    return Object.keys(stats.by_signal_type).sort();
  }, [stats]);

  const filteredFires = useMemo(() => {
    return fires.filter((f) => {
      if (filterType && f.signal_type !== filterType) return false;
      if (filterSymbol && !f.symbol.toLowerCase().includes(filterSymbol.toLowerCase())) return false;
      return true;
    });
  }, [fires, filterType, filterSymbol]);

  const totals = useMemo(() => {
    if (!stats) return { fires: 0, resolved: 0, wins: 0, losses: 0 };
    let f = 0, r = 0, w = 0, l = 0;
    for (const horizonMap of Object.values(stats.by_signal_type)) {
      for (const h of Object.values(horizonMap)) {
        if (!h) continue;
        f += h.total;
        r += h.resolved;
        w += h.wins;
        l += h.losses;
      }
    }
    // Fires counted across 4 horizons — divide
    return { fires: Math.round(f / HORIZONS.length), resolved: r, wins: w, losses: l };
  }, [stats]);

  return (
    <div className="max-w-[1500px] mx-auto space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <PageHeader eyebrow="Administration" title="Signal validation" description="Compare outcomes across 15-minute, hourly, end-of-day and next-session horizons." />
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted">Window:</label>
          <select aria-label="Validation window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-card border border-card-border rounded px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none"
          >
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={15}>15 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1 rounded border border-accent/30 text-accent hover:bg-accent-bg disabled:opacity-50 text-xs"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-loss-bg border border-loss/20 rounded-xl p-4 text-loss text-sm">
          {error}
        </div>
      )}

      {/* Top-line summary */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryCard label="Distinct Fires" value={String(totals.fires)} subtitle={`Last ${days} days`} />
          <SummaryCard label="Resolved Outcomes" value={String(totals.resolved)} subtitle={`Across all horizons`} />
          <SummaryCard label="Wins" value={String(totals.wins)} subtitle="✓" accent="profit" />
          <SummaryCard label="Losses" value={String(totals.losses)} subtitle="✗" accent="loss" />
        </div>
      )}

      {/* Per-signal-type stats table */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        <div className="px-4 py-2 border-b border-card-border">
          <h2 className="text-sm font-semibold">Win Rate by Signal Type × Horizon</h2>
          <p className="text-[11px] text-muted mt-0.5">
            Win = {">="}+0.5% (15m) / +1.0% (1h) / +1.5% (EOD) / +2.0% (next-day). Asymmetric for slippage. Bearish signals are sign-flipped.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-hover/50">
              <tr className="text-muted">
                <th className="text-left px-3 py-2 font-medium">Signal Type</th>
                {HORIZONS.map((h) => (
                  <th key={h} className="text-right px-3 py-2 font-medium" colSpan={3}>
                    {h.toUpperCase()}
                  </th>
                ))}
              </tr>
              <tr className="text-[10px] text-muted/70 uppercase tracking-wider border-b border-card-border">
                <th></th>
                {HORIZONS.map((h) => (
                  <>
                    <th key={`${h}-n`} className="text-right px-2 py-1 font-normal">N</th>
                    <th key={`${h}-w`} className="text-right px-2 py-1 font-normal">Win %</th>
                    <th key={`${h}-r`} className="text-right px-2 py-1 font-normal">Avg Ret</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {!stats || signalTypes.length === 0 ? (
                <tr>
                  <td colSpan={1 + HORIZONS.length * 3} className="text-center py-8 text-muted">
                    {loading ? "Loading..." : "No signal data yet — fires will appear once trading hours open and engines run."}
                  </td>
                </tr>
              ) : (
                signalTypes.map((st) => (
                  <tr key={st} className="border-b border-card-border/30 hover:bg-hover-bg">
                    <td className="px-3 py-2 font-mono font-medium text-foreground">{st}</td>
                    {HORIZONS.map((h) => {
                      const cell = stats.by_signal_type[st]?.[h];
                      return (
                        <CellGroup key={h} cell={cell} />
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent fires */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        <div className="px-4 py-2 border-b border-card-border flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-sm font-semibold">Recent Fires</h2>
            <p className="text-[11px] text-muted mt-0.5">
              {filteredFires.length} of {fires.length} loaded
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              placeholder="Filter symbol..."
              value={filterSymbol}
              onChange={(e) => setFilterSymbol(e.target.value)}
              className="bg-surface-hover border border-card-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none w-32"
            />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="bg-surface-hover border border-card-border rounded px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
            >
              <option value="">All types</option>
              {signalTypes.map((st) => (
                <option key={st} value={st}>{st}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card border-b border-card-border">
              <tr className="text-muted">
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-left px-3 py-2 font-medium">Symbol</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-right px-3 py-2 font-medium">Price</th>
                <th className="text-right px-3 py-2 font-medium">Strength</th>
                <th className="text-left px-3 py-2 font-medium">Dir</th>
                <th className="text-left px-3 py-2 font-medium">Conf</th>
                <th className="text-right px-3 py-2 font-medium">15m</th>
                <th className="text-right px-3 py-2 font-medium">1h</th>
                <th className="text-right px-3 py-2 font-medium">EOD</th>
                <th className="text-right px-3 py-2 font-medium">Next EOD</th>
              </tr>
            </thead>
            <tbody>
              {filteredFires.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-muted">
                    {loading ? "Loading..." : "No fires in this window."}
                  </td>
                </tr>
              ) : (
                filteredFires.map((f) => (
                  <FireRow key={f.id} fire={f} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  subtitle,
  accent,
}: {
  label: string;
  value: string;
  subtitle?: string;
  accent?: "profit" | "loss";
}) {
  const valueColor =
    accent === "profit" ? "text-profit" :
    accent === "loss" ? "text-loss" :
    "text-foreground";
  return (
    <div className="bg-card border border-card-border rounded-lg p-3">
      <div className="text-[10px] text-muted mb-1 uppercase tracking-wider">{label}</div>
      <div className={cn("text-2xl font-mono font-bold", valueColor)}>{value}</div>
      {subtitle && <div className="text-[10px] text-muted mt-1">{subtitle}</div>}
    </div>
  );
}

function CellGroup({ cell }: { cell: HorizonStats | undefined }) {
  if (!cell || cell.total === 0) {
    return (
      <>
        <td className="text-right px-2 py-2 text-muted/50">—</td>
        <td className="text-right px-2 py-2 text-muted/50">—</td>
        <td className="text-right px-2 py-2 text-muted/50">—</td>
      </>
    );
  }
  const winRate = cell.win_rate;
  const winColor =
    winRate == null ? "text-muted" :
    winRate >= 60 ? "text-profit font-bold" :
    winRate >= 50 ? "text-profit" :
    winRate >= 40 ? "text-warning" :
    "text-loss";
  const ret = cell.avg_return_pct;
  const retColor =
    ret == null ? "text-muted" :
    ret > 0 ? "text-profit" :
    ret < 0 ? "text-loss" :
    "text-muted";

  return (
    <>
      <td className="text-right px-2 py-2 font-mono text-muted">{cell.resolved}/{cell.total}</td>
      <td className={cn("text-right px-2 py-2 font-mono", winColor)}>
        {winRate != null ? `${winRate}%` : "—"}
      </td>
      <td className={cn("text-right px-2 py-2 font-mono", retColor)}>
        {ret != null ? `${ret > 0 ? "+" : ""}${ret}%` : "—"}
      </td>
    </>
  );
}

function FireRow({ fire }: { fire: SignalFire }) {
  const dirColor =
    fire.direction === "BULLISH" ? "text-profit" :
    fire.direction === "BEARISH" ? "text-loss" :
    "text-muted";
  const confColor =
    fire.confidence === "STRONG" ? "text-accent font-semibold" :
    fire.confidence === "MODERATE" ? "text-foreground" :
    "text-muted";

  const outcomeMap: Record<string, any> = {};
  (fire.signal_outcomes || []).forEach((o) => { outcomeMap[o.horizon] = o; });

  const time = new Date(fire.fired_at).toLocaleTimeString("en-IN", { hour12: false });

  return (
    <tr className="border-b border-card-border/30 hover:bg-hover-bg">
      <td className="px-3 py-1.5 text-muted font-mono">{time}</td>
      <td className="px-3 py-1.5 font-medium text-foreground">{fire.symbol}</td>
      <td className="px-3 py-1.5 font-mono text-[10px] text-muted">{fire.signal_type}</td>
      <td className="text-right px-3 py-1.5 font-mono">{fire.trigger_price?.toFixed(2) ?? "—"}</td>
      <td className="text-right px-3 py-1.5 font-mono">{fire.strength?.toFixed(0) ?? "—"}</td>
      <td className={cn("px-3 py-1.5 font-medium", dirColor)}>{fire.direction?.[0] ?? "—"}</td>
      <td className={cn("px-3 py-1.5 text-[10px]", confColor)}>{fire.confidence ?? "—"}</td>
      {HORIZONS.map((h) => (
        <OutcomeCell key={h} outcome={outcomeMap[h]} />
      ))}
    </tr>
  );
}

function OutcomeCell({ outcome }: { outcome: any | undefined }) {
  if (!outcome) {
    return <td className="text-right px-3 py-1.5 text-muted/50">—</td>;
  }
  if (outcome.status === "PENDING") {
    return <td className="text-right px-3 py-1.5 text-muted/50">·</td>;
  }
  const color =
    outcome.status === "WIN" ? "text-profit font-medium" :
    outcome.status === "LOSS" ? "text-loss font-medium" :
    "text-muted";
  return (
    <td className={cn("text-right px-3 py-1.5 font-mono text-[10px]", color)}>
      {outcome.return_pct != null ? `${outcome.return_pct > 0 ? "+" : ""}${outcome.return_pct.toFixed(2)}%` : outcome.status}
    </td>
  );
}
