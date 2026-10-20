"use client";

import { Fragment, useEffect, useState } from "react";
import { formatNumber, cn } from "../../lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

// ── Strong Movers (post-move) types ─────────────────────────────────────────
interface PillarScores {
  back_to_back: number;
  volume_surge: number;
  magnitude_speed: number;
  candle_quality: number;
  base_quality: number;
}

interface MoveDetails {
  move_low: number;
  move_high: number;
  move_pct: number;
  days_taken: number;
  consecutive_green: number;
  avg_vol_ratio_during_move: number;
}

interface InstResult {
  symbol: string;
  sector: string;
  score: number;
  stars: number;
  current_price: number;
  pillar_scores: PillarScores;
  move_details: MoveDetails;
  avg_turnover_cr: number;
  base_retrace_pct: number;
  alert_flags: string[];
}

// ── Accumulation (pre-move) types ───────────────────────────────────────────
interface AccumPillarScores {
  volume_divergence: number;
  range_contraction: number;
  coil_near_resistance: number;
  resilience: number;
  higher_lows: number;
}

interface AccumDetails {
  green_red_vol_ratio: number;
  price_drift_pct: number;
  range_contraction_ratio: number;
  range_pct_of_price: number;
  distance_from_high_pct: number;
  days_near_high: number;
  red_day_recovery_rate: number;
  higher_lows_pct: number;
}

interface AccumResult {
  symbol: string;
  sector: string;
  score: number;
  stars: number;
  current_price: number;
  pillar_scores: AccumPillarScores;
  details: AccumDetails;
  avg_turnover_cr: number;
  alert_flags: string[];
}

interface SectorCluster {
  sector: string;
  count: number;
  avg_score: number;
  symbols: string[];
}

interface ScanResponse {
  // strong movers (post-move)
  stocks: InstResult[];
  clusters: SectorCluster[];
  stats: {
    scanned: number;
    filtered_liquidity: number;
    qualifying: number;
    errors: number;
    five_star: number;
    four_star: number;
    three_star: number;
    elapsed_sec: number;
  };
  // accumulation (pre-move) — additive, may be missing on older deployments
  accumulation_stocks?: AccumResult[];
  accumulation_clusters?: SectorCluster[];
  accumulation_stats?: {
    qualifying: number;
    five_star: number;
    four_star: number;
    three_star: number;
  };
  timestamp: number;
  cached?: boolean;
  stale?: boolean;
  age_seconds?: number;
  scanning?: boolean;
}

const PILLAR_META: { key: keyof PillarScores; label: string; max: number }[] = [
  { key: "back_to_back", label: "Back-to-Back", max: 30 },
  { key: "volume_surge", label: "Volume Surge", max: 25 },
  { key: "magnitude_speed", label: "Magnitude/Speed", max: 20 },
  { key: "candle_quality", label: "Candle Quality", max: 15 },
  { key: "base_quality", label: "Base Quality", max: 10 },
];

const ACCUM_PILLAR_META: { key: keyof AccumPillarScores; label: string; max: number }[] = [
  { key: "volume_divergence", label: "Volume Divergence", max: 35 },
  { key: "range_contraction", label: "Range Contraction", max: 25 },
  { key: "coil_near_resistance", label: "Coil at Resistance", max: 15 },
  { key: "resilience", label: "Down-Day Resilience", max: 15 },
  { key: "higher_lows", label: "Higher Lows", max: 10 },
];

type View = "accumulation" | "movers";

export function InstitutionalBuyingScanner() {
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("accumulation");
  const [starFilter, setStarFilter] = useState<"all" | "5" | "4" | "3">("all");
  const [sortBy, setSortBy] = useState<"score" | "move_pct" | "vol_ratio">("score");
  const [universe, setUniverse] = useState<"nifty500" | "fno" | "all">("nifty500");
  const [expanded, setExpanded] = useState<string | null>(null);

  async function fetchOnce(force = false): Promise<ScanResponse | null> {
    const qs = new URLSearchParams({ universe });
    if (force) qs.set("refresh", "true");
    const url = `${API_URL}/api/institutional-buying?${qs.toString()}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return (await res.json()) as ScanResponse;
  }

  async function runScan(force = false) {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchOnce(force);
      setData(json);
    } catch (err: any) {
      setError(err.message || "Scan failed");
    } finally {
      setLoading(false);
    }
  }

  // Initial load on mount or universe change
  useEffect(() => {
    runScan(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universe]);

  // Poll every 10s while a scan is in progress
  useEffect(() => {
    if (!data?.scanning) return;
    const id = setInterval(async () => {
      try {
        const json = await fetchOnce(false);
        setData(json);
      } catch {
        /* ignore transient errors while polling */
      }
    }, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.scanning, universe]);

  const accumStocks = data?.accumulation_stocks ?? [];
  const accumClusters = data?.accumulation_clusters ?? [];
  const accumAvailable = !!data?.accumulation_stats;

  // Filter & sort for current view
  const isAccum = view === "accumulation" && accumAvailable;
  const stocks: (InstResult | AccumResult)[] = isAccum ? accumStocks : data?.stocks ?? [];
  const clusters = isAccum ? accumClusters : data?.clusters ?? [];

  const filtered = stocks.filter((s) => {
    if (starFilter === "all") return true;
    return String(s.stars) === starFilter;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (isAccum) {
      // For accumulation, sortBy "move_pct" → vol-divergence ratio,
      // "vol_ratio" → range tightness (smaller = better, so flip)
      const ar = (a as AccumResult).details;
      const br = (b as AccumResult).details;
      if (sortBy === "move_pct") return br.green_red_vol_ratio - ar.green_red_vol_ratio;
      if (sortBy === "vol_ratio") return ar.range_pct_of_price - br.range_pct_of_price;
      return b.score - a.score;
    }
    const am = (a as InstResult).move_details;
    const bm = (b as InstResult).move_details;
    if (sortBy === "move_pct") return bm.move_pct - am.move_pct;
    if (sortBy === "vol_ratio") return bm.avg_vol_ratio_during_move - am.avg_vol_ratio_during_move;
    return b.score - a.score;
  });

  const scanTime = data?.timestamp
    ? new Date(data.timestamp).toLocaleTimeString()
    : null;
  const isStale = data?.stale || (data?.age_seconds ?? 0) > 1800;

  return (
    <div className="space-y-4">
      {/* View toggle (Accumulation vs Strong Movers) */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide border-b border-divider">
        <button
          onClick={() => setView("accumulation")}
          disabled={!accumAvailable}
          className={cn(
            "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 shrink-0",
            view === "accumulation"
              ? "bg-accent text-white font-semibold shadow-sm"
              : "text-muted hover:text-foreground hover:bg-surface-hover",
            !accumAvailable && "opacity-50 cursor-not-allowed"
          )}
          title={accumAvailable ? "Pre-move accumulation patterns — quiet stocks before they break out" : "Backend doesn't yet support accumulation scoring"}
        >
          Accumulation (Pre-Move)
          {accumAvailable && data?.accumulation_stats && (
            <span className={cn("ml-1.5 text-[11px]", view === "accumulation" ? "text-white/80" : "text-muted/70")}>
              {data.accumulation_stats.qualifying}
            </span>
          )}
        </button>
        <button
          onClick={() => setView("movers")}
          className={cn(
            "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 shrink-0",
            view === "movers"
              ? "bg-accent text-white font-semibold shadow-sm"
              : "text-muted hover:text-foreground hover:bg-surface-hover"
          )}
          title="Post-move confirmation — stocks that have already moved with strong footprints"
        >
          Strong Movers (Post-Move)
          {data?.stats && (
            <span className={cn("ml-1.5 text-[11px]", view === "movers" ? "text-white/80" : "text-muted/70")}>
              {data.stats.qualifying}
            </span>
          )}
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["all", "5", "4", "3"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setStarFilter(k)}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-medium transition-colors",
                  starFilter === k
                    ? "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {k === "all" ? "All" : `${k}★`}
              </button>
            ))}
          </div>
          <select
            value={universe}
            onChange={(e) => setUniverse(e.target.value as any)}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-xs"
          >
            <option value="nifty500">Universe: Nifty 500</option>
            <option value="fno">Universe: F&amp;O</option>
            <option value="all">Universe: All NSE (~2000)</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-xs"
          >
            <option value="score">Sort: Score</option>
            {isAccum ? (
              <>
                <option value="move_pct">Sort: Vol Divergence</option>
                <option value="vol_ratio">Sort: Tightness</option>
              </>
            ) : (
              <>
                <option value="move_pct">Sort: Move %</option>
                <option value="vol_ratio">Sort: Vol Ratio</option>
              </>
            )}
          </select>
          {scanTime && (
            <span
              className={cn(
                "text-xs",
                isStale ? "text-warning" : "text-muted"
              )}
            >
              {isStale ? "⟳ Stale — " : ""}Scanned {scanTime}
            </span>
          )}
        </div>
        <button
          onClick={() => runScan(true)}
          disabled={loading}
          className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 disabled:opacity-50"
        >
          {loading ? "Scanning..." : "Scan Now"}
        </button>
      </div>

      <p className="text-xs text-muted">
        {isAccum ? (
          <>
            <strong className="text-foreground">Accumulation (Pre-Move):</strong>{" "}
            5-pillar score for stocks being quietly accumulated <em>before</em>{" "}
            the breakout. Looks for asymmetric volume on flat price, tight bases,
            coiling near resistance, and resilience on dips. Lower hit-rate but
            earlier entries than the post-move scan.
          </>
        ) : (
          <>
            <strong className="text-foreground">Strong Movers (Post-Move):</strong>{" "}
            5-pillar score (0–100) over 6 months of daily data. Identifies stocks
            that have <em>already</em> shown institutional footprints — useful for
            confirmation and for spotting bases after a strong leg.
          </>
        )}
        {" "}Filters out stocks with {"<"} ₹50 Cr avg daily turnover.
      </p>

      {error && (
        <div className="bg-loss-bg border border-loss/20 rounded-lg p-4 text-loss text-sm">
          {error}
        </div>
      )}

      {/* Sector clusters */}
      {clusters.length > 0 && (
        <div className="space-y-2">
          {clusters.map((c) => (
            <div
              key={c.sector}
              className="bg-[rgba(234,88,12,0.08)] border border-[#ea580c]/30 rounded-lg p-3 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="text-[#fb923c] font-semibold">
                  🔥 Sector Cluster: {c.sector}
                </span>
                <span className="text-muted text-xs">
                  {c.count} stocks · avg score {c.avg_score}
                </span>
              </div>
              <div className="text-xs text-muted mt-1">
                {c.symbols.join(" · ")}
              </div>
            </div>
          ))}
        </div>
      )}

      {(loading && !data) || data?.scanning ? (
        <div className="bg-card border border-card-border rounded-lg p-6 text-center">
          <div className="animate-pulse text-accent">
            {data?.scanning
              ? `Scanning ${universe === "fno" ? "F&O (~160)" : universe === "all" ? "all NSE (~2000)" : "Nifty 500"} — this runs in the background and can take 2–5 min. Results appear here automatically.`
              : "Running 6-month institutional scan…"}
          </div>
        </div>
      ) : null}

      {data && (
        <>
          {/* Stats bar */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Scanned: </span>
              <span className="font-medium">{data.stats.scanned}</span>
            </div>
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Liquidity filtered: </span>
              <span className="font-medium">{data.stats.filtered_liquidity}</span>
            </div>
            <div className="bg-accent-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-accent font-medium">
                {isAccum
                  ? data.accumulation_stats?.qualifying ?? 0
                  : data.stats.qualifying}
              </span>
              <span className="text-accent/70 ml-1">Qualifying</span>
            </div>
            <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">
                {isAccum
                  ? data.accumulation_stats?.five_star ?? 0
                  : data.stats.five_star}
              </span>
              <span className="text-profit/70 ml-1">5★</span>
            </div>
          </div>

          {/* Results table */}
          <div className="bg-card border border-card-border rounded-lg overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              {isAccum ? (
                <AccumulationTable
                  rows={sorted as AccumResult[]}
                  expanded={expanded}
                  setExpanded={setExpanded}
                />
              ) : (
                <MoversTable
                  rows={sorted as InstResult[]}
                  expanded={expanded}
                  setExpanded={setExpanded}
                />
              )}
              {sorted.length === 0 && !loading && !data?.scanning && (
                <div className="text-center py-8 text-muted">
                  {isAccum && !accumAvailable
                    ? "Backend hasn't been deployed with accumulation scoring yet."
                    : "No qualifying stocks for the current filter."}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}


// ── Strong Movers table ─────────────────────────────────────────────────────
function MoversTable({
  rows,
  expanded,
  setExpanded,
}: {
  rows: InstResult[];
  expanded: string | null;
  setExpanded: (s: string | null) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-card z-10">
        <tr className="border-b border-card-border text-muted text-xs">
          <th className="text-center px-3 py-2">★</th>
          <th className="text-left px-3 py-2">Symbol</th>
          <th className="text-left px-3 py-2">Sector</th>
          <th className="text-right px-3 py-2">Price</th>
          <th className="text-right px-3 py-2">Move %</th>
          <th className="text-right px-3 py-2">Days</th>
          <th className="text-right px-3 py-2">Green Streak</th>
          <th className="text-right px-3 py-2">Vol Ratio</th>
          <th className="text-right px-3 py-2">Turnover (Cr)</th>
          <th className="text-center px-3 py-2">Score</th>
          <th className="text-center px-3 py-2"> </th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows.map((r) => {
          const isOpen = expanded === r.symbol;
          const borderColor =
            r.stars === 5 ? "border-l-profit"
              : r.stars === 4 ? "border-l-accent"
                : "border-l-warning";
          return (
            <Fragment key={r.symbol}>
              <tr
                className={cn(
                  "border-b border-card-border/50 hover:bg-hover-bg cursor-pointer border-l-2",
                  borderColor
                )}
                onClick={() => setExpanded(isOpen ? null : r.symbol)}
              >
                <td className="text-center px-3 py-2">
                  <span className="text-warning">{"★".repeat(r.stars)}</span>
                </td>
                <td className="px-3 py-2 font-medium text-foreground">{r.symbol}</td>
                <td className="px-3 py-2 text-muted text-xs">{r.sector}</td>
                <td className="text-right px-3 py-2">{formatNumber(r.current_price)}</td>
                <td className="text-right px-3 py-2 text-profit">+{r.move_details.move_pct.toFixed(1)}%</td>
                <td className="text-right px-3 py-2">{r.move_details.days_taken}</td>
                <td className="text-right px-3 py-2">{r.move_details.consecutive_green}</td>
                <td className="text-right px-3 py-2">
                  <span
                    className={cn(
                      "font-medium",
                      r.move_details.avg_vol_ratio_during_move >= 5
                        ? "text-profit"
                        : r.move_details.avg_vol_ratio_during_move >= 3
                          ? "text-accent"
                          : "text-muted"
                    )}
                  >
                    {r.move_details.avg_vol_ratio_during_move.toFixed(1)}x
                  </span>
                </td>
                <td className="text-right px-3 py-2 text-muted">{r.avg_turnover_cr.toFixed(0)}</td>
                <td className="text-center px-3 py-2">
                  <ScoreBar score={r.score} />
                </td>
                <td className="text-center px-3 py-2 text-muted">{isOpen ? "▾" : "▸"}</td>
              </tr>
              {isOpen && (
                <tr className="bg-[rgba(0,0,0,0.15)] border-b border-card-border/50">
                  <td colSpan={11} className="px-4 py-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <PillarBars
                        meta={PILLAR_META as any}
                        scores={r.pillar_scores as any}
                      />
                      <div className="text-xs space-y-1">
                        <div className="text-muted mb-1">Move details</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
                          <div>
                            <span className="text-muted">Low → High: </span>
                            {formatNumber(r.move_details.move_low)} → {formatNumber(r.move_details.move_high)}
                          </div>
                          <div>
                            <span className="text-muted">Retrace: </span>
                            {r.base_retrace_pct.toFixed(1)}%
                          </div>
                          <div>
                            <span className="text-muted">Days: </span>
                            {r.move_details.days_taken}
                          </div>
                          <div>
                            <span className="text-muted">Green streak: </span>
                            {r.move_details.consecutive_green}
                          </div>
                        </div>
                        <FlagsList flags={r.alert_flags} />
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}


// ── Accumulation table ──────────────────────────────────────────────────────
function AccumulationTable({
  rows,
  expanded,
  setExpanded,
}: {
  rows: AccumResult[];
  expanded: string | null;
  setExpanded: (s: string | null) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-card z-10">
        <tr className="border-b border-card-border text-muted text-xs">
          <th className="text-center px-3 py-2">★</th>
          <th className="text-left px-3 py-2">Symbol</th>
          <th className="text-left px-3 py-2">Sector</th>
          <th className="text-right px-3 py-2">Price</th>
          <th className="text-right px-3 py-2">Vol Div</th>
          <th className="text-right px-3 py-2">Range %</th>
          <th className="text-right px-3 py-2">Dist High</th>
          <th className="text-right px-3 py-2">Days Near</th>
          <th className="text-right px-3 py-2">Recovery</th>
          <th className="text-right px-3 py-2">Drift %</th>
          <th className="text-center px-3 py-2">Score</th>
          <th className="text-center px-3 py-2"> </th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows.map((r) => {
          const isOpen = expanded === r.symbol;
          const borderColor =
            r.stars === 5 ? "border-l-profit"
              : r.stars === 4 ? "border-l-accent"
                : "border-l-warning";
          const d = r.details;
          return (
            <Fragment key={r.symbol}>
              <tr
                className={cn(
                  "border-b border-card-border/50 hover:bg-hover-bg cursor-pointer border-l-2",
                  borderColor
                )}
                onClick={() => setExpanded(isOpen ? null : r.symbol)}
              >
                <td className="text-center px-3 py-2">
                  <span className="text-warning">{"★".repeat(r.stars)}</span>
                </td>
                <td className="px-3 py-2 font-medium text-foreground">{r.symbol}</td>
                <td className="px-3 py-2 text-muted text-xs">{r.sector}</td>
                <td className="text-right px-3 py-2">{formatNumber(r.current_price)}</td>
                <td className="text-right px-3 py-2">
                  <span
                    className={cn(
                      "font-medium",
                      d.green_red_vol_ratio >= 2.0
                        ? "text-profit"
                        : d.green_red_vol_ratio >= 1.5
                          ? "text-accent"
                          : "text-muted"
                    )}
                  >
                    {d.green_red_vol_ratio.toFixed(2)}x
                  </span>
                </td>
                <td className="text-right px-3 py-2">
                  <span className={cn(d.range_pct_of_price <= 4 ? "text-profit" : "text-muted")}>
                    {d.range_pct_of_price.toFixed(1)}%
                  </span>
                </td>
                <td className="text-right px-3 py-2">
                  <span className={cn(d.distance_from_high_pct <= 2 ? "text-profit" : "text-muted")}>
                    {d.distance_from_high_pct.toFixed(1)}%
                  </span>
                </td>
                <td className="text-right px-3 py-2">{d.days_near_high}</td>
                <td className="text-right px-3 py-2">
                  <span className={cn(d.red_day_recovery_rate >= 0.75 ? "text-profit" : "text-muted")}>
                    {(d.red_day_recovery_rate * 100).toFixed(0)}%
                  </span>
                </td>
                <td className="text-right px-3 py-2">
                  <span
                    className={cn(
                      Math.abs(d.price_drift_pct) <= 3 ? "text-profit" : "text-muted"
                    )}
                  >
                    {d.price_drift_pct >= 0 ? "+" : ""}{d.price_drift_pct.toFixed(1)}%
                  </span>
                </td>
                <td className="text-center px-3 py-2">
                  <ScoreBar score={r.score} />
                </td>
                <td className="text-center px-3 py-2 text-muted">{isOpen ? "▾" : "▸"}</td>
              </tr>
              {isOpen && (
                <tr className="bg-[rgba(0,0,0,0.15)] border-b border-card-border/50">
                  <td colSpan={12} className="px-4 py-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <PillarBars
                        meta={ACCUM_PILLAR_META as any}
                        scores={r.pillar_scores as any}
                      />
                      <div className="text-xs space-y-1">
                        <div className="text-muted mb-1">Why this is flagged</div>
                        <ul className="list-disc list-inside space-y-1 text-foreground">
                          {d.green_red_vol_ratio >= 1.5 && (
                            <li>
                              Green-day volume is{" "}
                              <strong>{d.green_red_vol_ratio.toFixed(2)}x</strong>{" "}
                              red-day volume — asymmetric absorption
                            </li>
                          )}
                          {d.range_contraction_ratio <= 0.5 && d.range_pct_of_price <= 6 && (
                            <li>
                              Range has contracted to{" "}
                              <strong>{d.range_pct_of_price.toFixed(1)}%</strong> of
                              price (
                              {(d.range_contraction_ratio * 100).toFixed(0)}% of prior 30-day range)
                            </li>
                          )}
                          {d.distance_from_high_pct <= 4 && d.days_near_high >= 3 && (
                            <li>
                              Pinned within{" "}
                              <strong>{d.distance_from_high_pct.toFixed(1)}%</strong>{" "}
                              of recent high for {d.days_near_high}/10 sessions
                            </li>
                          )}
                          {d.red_day_recovery_rate >= 0.6 && (
                            <li>
                              {(d.red_day_recovery_rate * 100).toFixed(0)}% of red days were
                              bought back within 1-2 sessions — strong floor
                            </li>
                          )}
                          {d.higher_lows_pct >= 1.5 && Math.abs(d.price_drift_pct) <= 6 && (
                            <li>
                              Lows climbing{" "}
                              <strong>{d.higher_lows_pct.toFixed(1)}%</strong> on
                              flat price action — visible absorption
                            </li>
                          )}
                          {Math.abs(d.price_drift_pct) <= 3 && (
                            <li>
                              Price drift over the window is just{" "}
                              <strong>{d.price_drift_pct.toFixed(1)}%</strong> — this
                              is a true PRE-move setup, not a confirmation
                            </li>
                          )}
                        </ul>
                        <div className="text-muted mt-3">Liquidity</div>
                        <div className="font-mono">
                          Avg turnover: <strong>{r.avg_turnover_cr.toFixed(0)} Cr/day</strong>
                        </div>
                        <FlagsList flags={r.alert_flags} />
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}


// ── Shared sub-components ───────────────────────────────────────────────────
function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center justify-center gap-1">
      <div className="w-10 h-1.5 bg-card-border/30 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full",
            score >= 80 ? "bg-profit" : score >= 65 ? "bg-accent" : "bg-warning"
          )}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs w-6">{score}</span>
    </div>
  );
}

function PillarBars({
  meta,
  scores,
}: {
  meta: { key: string; label: string; max: number }[];
  scores: Record<string, number>;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted mb-1">Pillar breakdown</div>
      {meta.map((p) => {
        const v = scores[p.key] ?? 0;
        const pct = (v / p.max) * 100;
        return (
          <div key={p.key} className="flex items-center gap-2 text-xs">
            <span className="w-36 text-muted">{p.label}</span>
            <div className="flex-1 h-2 bg-card-border/30 rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-12 text-right font-mono">
              {v}/{p.max}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FlagsList({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {flags.map((f) => (
        <span
          key={f}
          className="text-[10px] px-1.5 py-0.5 rounded bg-accent-bg text-accent border border-accent/20"
        >
          {f}
        </span>
      ))}
    </div>
  );
}
