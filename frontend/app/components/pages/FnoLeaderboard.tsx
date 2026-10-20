"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchAPI } from "../../lib/api";
import { cn, formatNumber, isMarketOpen, profitLossColor } from "../../lib/utils";
import { getSector } from "../../lib/stock-universe";

interface FutureRow {
  name: string;
  tradingsymbol: string;
  expiry: string;
  lotSize: number;
  last: number;
  volume: number;
  oi: number;
  oiDayLow?: number;
  oiChange?: number;
  oiChangePercent?: number;
  change: number;
  changePercent: string | number;
}

type SortMetric = "oiChangePct" | "changePct";
type ScopeFilter = "all" | "advancing" | "declining" | "oi_buildup";

interface EnrichedRow extends FutureRow {
  changePct: number;
  oiChangePct: number;
  sector: string;
  buildup: BuildupLabel;
}

type BuildupLabel = "Long Buildup" | "Short Buildup" | "Short Covering" | "Long Unwinding" | "Neutral";

interface FnoLeaderboardProps {
  onSelectStock: (symbol: string) => void;
}

const SCOPE_FILTERS: { key: ScopeFilter; label: string }[] = [
  { key: "all", label: "All Stocks" },
  { key: "advancing", label: "Advancing" },
  { key: "declining", label: "Declining" },
  { key: "oi_buildup", label: "OI Buildup" },
];

const METRICS: { key: SortMetric; label: string; description: string }[] = [
  { key: "oiChangePct", label: "OI Change %", description: "Sort by Open Interest buildup" },
  { key: "changePct", label: "Price Change %", description: "Sort by today's price move" },
];

export default function FnoLeaderboard({ onSelectStock }: FnoLeaderboardProps) {
  const [rows, setRows] = useState<EnrichedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState("");
  const [metric, setMetric] = useState<SortMetric>("oiChangePct");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [sector, setSector] = useState<string>("All");
  const [lastUpdated, setLastUpdated] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchAPI("/api/fno/futures");
        if (cancelled) return;
        if (!res.success || !Array.isArray(res.data)) throw new Error("Futures quotes are unavailable.");
        const enriched: EnrichedRow[] = (res.data as FutureRow[]).map((r) => {
          const changePct = Number(r.changePercent) || 0;
          const oiChangePct = Number(r.oiChangePercent) || 0;
          return {
            ...r,
            changePct,
            oiChangePct,
            sector: getSector(r.name),
            buildup: interpretBuildup(changePct, oiChangePct),
          };
        });
        setRows(enriched);
        setError(enriched.length ? "" : "The futures feed returned no quotes.");
        setLastUpdated(Date.now());
      } catch {
        if (!cancelled) setError("Futures quotes could not be refreshed.");
      }
      if (!cancelled) setLoading(false);
    }
    load();
    const timer = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [retry]);

  // All sectors present in the data, alphabetised
  const sectors = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => s.add(r.sector));
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  // Apply search + scope + sector filters (all additive, intersection)
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .filter((r) => {
        if (scope === "advancing") return r.changePct > 0;
        if (scope === "declining") return r.changePct < 0;
        if (scope === "oi_buildup") return r.oiChangePct > 0;
        return true;
      })
      .filter((r) => sector === "All" || r.sector === sector);
  }, [rows, filter, scope, sector]);

  // Sort by absolute value of selected metric (top movers — both directions)
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = metric === "oiChangePct" ? a.oiChangePct : a.changePct;
      const bv = metric === "oiChangePct" ? b.oiChangePct : b.changePct;
      return Math.abs(bv) - Math.abs(av);
    });
  }, [filtered, metric]);

  // Counts for filter-tab labels
  const counts = useMemo(() => {
    const totalAll = rows.length;
    const advancing = rows.filter((r) => r.changePct > 0).length;
    const declining = rows.filter((r) => r.changePct < 0).length;
    const oiBuildup = rows.filter((r) => r.oiChangePct > 0).length;
    return { all: totalAll, advancing, declining, oi_buildup: oiBuildup };
  }, [rows]);

  // Max abs value for the mini-bar visualization scale
  const barMax = useMemo(() => {
    const v = sorted.map((r) =>
      Math.abs(metric === "oiChangePct" ? r.oiChangePct : r.changePct)
    );
    const m = Math.max(...v, 1);
    return Math.min(m, 30); // cap so a few outliers don't squash the rest
  }, [sorted, metric]);

  return (
    <div className="space-y-4">
      {error && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm"><span>{error}</span><button className="workspace-button" onClick={() => setRetry(value => value + 1)}>Retry quotes</button></div>}
      {/* Top control row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            aria-label="Filter futures stocks"
            placeholder="Search stock..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-card border border-card-border rounded px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none w-48"
          />
          {lastUpdated > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  isMarketOpen() ? "bg-profit animate-pulse" : "bg-yellow-500"
                )}
              />
              {isMarketOpen() ? "Live" : "Last Session"}
            </span>
          )}
        </div>
        <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
          {METRICS.map((m) => (
            <button
              key={m.key}
              aria-pressed={metric === m.key}
              onClick={() => setMetric(m.key)}
              title={m.description}
              className={cn(
                "px-3 py-1.5 rounded text-xs font-medium transition-colors",
                metric === m.key
                  ? "bg-accent text-white"
                  : "text-muted hover:text-foreground"
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scope filter tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide border-b border-divider">
        {SCOPE_FILTERS.map((f) => {
          const count = counts[f.key];
          const active = scope === f.key;
          return (
            <button
              key={f.key}
              aria-pressed={scope === f.key}
              onClick={() => setScope(f.key)}
              className={cn(
                "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 shrink-0",
                active
                  ? "bg-accent text-white font-semibold shadow-sm"
                  : "text-muted hover:text-foreground hover:bg-surface-hover"
              )}
            >
              {f.label}
              {!loading && (
                <span className={cn("ml-1.5 text-[11px]", active ? "text-white/80" : "text-muted/70")}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sector tabs */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-hide">
        {sectors.map((s) => {
          const active = sector === s;
          return (
            <button
              key={s}
              onClick={() => setSector(s)}
              className={cn(
                "px-3 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                active
                  ? "bg-accent-bg text-accent border border-accent/30"
                  : "text-muted hover:text-foreground hover:bg-surface-hover border border-transparent"
              )}
            >
              {s}
            </button>
          );
        })}
      </div>

      {/* Result count */}
      <div className="text-xs text-muted">
        Showing <strong className="text-foreground">{sorted.length}</strong> of {rows.length} F&O stocks
        {scope !== "all" && (
          <span> — filter: <strong className="text-foreground">{SCOPE_FILTERS.find((f) => f.key === scope)?.label}</strong></span>
        )}
        {sector !== "All" && (
          <span> — sector: <strong className="text-foreground">{sector}</strong></span>
        )}
      </div>

      {/* Leaderboard list */}
      <div className="bg-card border border-card-border rounded-xl overflow-x-auto">
        {/* Table header */}
        <div className="grid min-w-[820px] grid-cols-[40px_1.6fr_1fr_1fr_1fr_1fr_1.4fr] gap-3 items-center px-4 py-2.5 border-b border-card-border text-[11px] font-semibold uppercase tracking-wider text-muted">
          <div>#</div>
          <div>Symbol</div>
          <div className="text-right">LTP</div>
          <div className="text-right">Change %</div>
          <div className="text-right">OI</div>
          <div className="text-right">OI Δ %</div>
          <div className="pl-2">Buildup</div>
        </div>

        {/* Body */}
        {loading && rows.length === 0 ? (
          <div className="divide-y divide-card-border/40">
            {[...Array(15)].map((_, i) => (
              <div
                key={i}
                className="grid min-w-[820px] grid-cols-[40px_1.6fr_1fr_1fr_1fr_1fr_1.4fr] gap-3 items-center px-4 py-2.5"
              >
                <div className="h-3 bg-card-border/30 rounded animate-pulse" />
                <div className="h-3 bg-card-border/30 rounded animate-pulse" />
                <div className="h-3 bg-card-border/30 rounded animate-pulse" />
                <div className="h-3 bg-card-border/30 rounded animate-pulse" />
                <div className="h-3 bg-card-border/30 rounded animate-pulse" />
                <div className="h-3 bg-card-border/30 rounded animate-pulse" />
                <div className="h-3 bg-card-border/30 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted">
            {rows.length ? "No stocks match the current filters." : "No futures quotes available. Retry the feed to check again."}
          </div>
        ) : (
          <div className="divide-y divide-card-border/40 max-h-[640px] overflow-y-auto">
            {sorted.map((row, idx) => (
              <LeaderboardRow
                key={row.tradingsymbol}
                row={row}
                rank={idx + 1}
                metric={metric}
                barMax={barMax}
                onClick={() => onSelectStock(row.name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LeaderboardRow({
  row,
  rank,
  metric,
  barMax,
  onClick,
}: {
  row: EnrichedRow;
  rank: number;
  metric: SortMetric;
  barMax: number;
  onClick: () => void;
}) {
  const value = metric === "oiChangePct" ? row.oiChangePct : row.changePct;
  const intensity = Math.min(1, Math.abs(value) / barMax);
  const barWidth = `${Math.max(4, intensity * 100)}%`;
  const positive = value > 0;
  const barColor = positive ? "bg-profit/60" : value < 0 ? "bg-loss/60" : "bg-muted/30";
  const buildupColor = buildupTextColor(row.buildup);

  return (
    <button
      onClick={onClick}
      className="w-full grid min-w-[820px] grid-cols-[40px_1.6fr_1fr_1fr_1fr_1fr_1.4fr] gap-3 items-center px-4 py-2.5 text-left hover:bg-hover-bg transition-colors"
    >
      <div className="text-xs text-muted font-mono">{rank}</div>
      <div>
        <div className="text-sm font-semibold text-foreground">{row.name}</div>
        <div className="text-[10px] text-muted">{row.sector}</div>
      </div>
      <div className="text-right text-sm font-mono">{formatNumber(row.last)}</div>
      <div className={cn("text-right text-sm font-mono font-medium", profitLossColor(row.changePct))}>
        {row.changePct >= 0 ? "+" : ""}{row.changePct.toFixed(2)}%
      </div>
      <div className="text-right text-sm font-mono text-muted">
        {(row.oi / 100000).toFixed(1)}L
      </div>
      <div className={cn("text-right text-sm font-mono font-medium", profitLossColor(row.oiChangePct))}>
        {row.oiChangePct >= 0 ? "+" : ""}{row.oiChangePct.toFixed(2)}%
      </div>
      <div className="pl-2 flex items-center gap-2 min-w-0">
        <div className="flex-1 h-1.5 bg-card-border/20 rounded overflow-hidden">
          <div className={cn("h-full rounded transition-all", barColor)} style={{ width: barWidth }} />
        </div>
        <span className={cn("text-[10px] font-medium whitespace-nowrap", buildupColor)}>
          {row.buildup}
        </span>
      </div>
    </button>
  );
}

function interpretBuildup(priceChangePct: number, oiChangePct: number): BuildupLabel {
  const priceUp = priceChangePct > 0.1;
  const priceDown = priceChangePct < -0.1;
  const oiUp = oiChangePct > 1;
  const oiDown = oiChangePct < -1;

  if (priceUp && oiUp) return "Long Buildup";
  if (priceDown && oiUp) return "Short Buildup";
  if (priceUp && oiDown) return "Short Covering";
  if (priceDown && oiDown) return "Long Unwinding";
  return "Neutral";
}

function buildupTextColor(b: BuildupLabel): string {
  switch (b) {
    case "Long Buildup":
      return "text-profit";
    case "Short Buildup":
      return "text-loss";
    case "Short Covering":
      return "text-profit/70";
    case "Long Unwinding":
      return "text-loss/70";
    default:
      return "text-muted";
  }
}
