"use client";

import { ScannerEmptyState } from "./ScannerEmptyState";

import { useState } from "react";
import { fetchAPI } from "../../lib/api";
import { formatNumber, cn } from "../../lib/utils";
import {
  type UniverseKey,
  UNIVERSE_META,
  getUniverse,
} from "../../lib/stock-universe";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface TimeframeDetail {
  name: string;
  total: number;
  cpr_direction: string;
  cpr_width_class: string;
  pema_stack: string;
  pema_slope: string;
  consecutive_ascending: number;
  consecutive_descending: number;
  price_vs_cpr: string;
  is_valid_for_long: boolean;
  is_valid_for_short: boolean;
}

interface MultiTFResult {
  symbol: string;
  current_price: number;
  total_score: number;
  alert_tier: string;
  direction: string;
  monthly: TimeframeDetail;
  weekly: TimeframeDetail;
  daily: TimeframeDetail;
  entry_price?: number;
  stop_loss?: number;
  target_1r2?: number;
  target_1r3?: number;
  notes: string[];
  error?: string;
}

type TFView = "all" | "daily" | "weekly" | "monthly";

const tierColors: Record<string, string> = {
  "A+": "text-profit bg-profit-bg",
  B: "text-accent bg-accent-bg",
  Watch: "text-warning bg-[rgba(255,193,7,0.1)]",
  None: "text-muted",
};

const cprDirLabel: Record<string, { icon: string; color: string; label: string }> = {
  ascending: { icon: "↑", color: "text-profit", label: "Ascending" },
  descending: { icon: "↓", color: "text-loss", label: "Descending" },
  parallel: { icon: "→", color: "text-warning", label: "Parallel" },
  unknown: { icon: "?", color: "text-muted", label: "Unknown" },
};

export function CPRScanner() {
  const [universe, setUniverse] = useState<UniverseKey>("nifty50");
  const [results, setResults] = useState<MultiTFResult[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [tfView, setTfView] = useState<TFView>("all");
  const [dirFilter, setDirFilter] = useState<"all" | "LONG" | "SHORT">("all");

  async function runScan() {
    setHasScanned(true);
    setLoading(true);
    setError(null);
    setProgress(0);

    const symbols = getUniverse(universe);

    try {
      const batchPayload: any[] = [];
      const BATCH_SIZE = 3;

      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        setProgress(Math.round((i / symbols.length) * 80));

        const promises = batch.map(async (sym) => {
          try {
            const [daily, weekly, monthly] = await Promise.all([
              fetchAPI(`/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=day&days=120`),
              fetchAPI(`/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=week&days=420`).catch(() => ({ success: false, data: [] })),
              fetchAPI(`/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=month&days=730`).catch(() => ({ success: false, data: [] })),
            ]);

            if (daily.success && daily.data.length > 0) {
              batchPayload.push({
                symbol: sym,
                daily: daily.data,
                weekly: weekly.success && weekly.data?.length > 0 ? weekly.data : null,
                monthly: monthly.success && monthly.data?.length > 0 ? monthly.data : null,
                current_price: daily.data[daily.data.length - 1].close,
              });
            }
          } catch {}
        });
        await Promise.all(promises);
        if (i + BATCH_SIZE < symbols.length) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      setProgress(85);

      if (!batchPayload.length) throw new Error("No usable price history was received for this universe.");
      const scanRes = await fetch(`${API_URL}/api/scanner/cpr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: batchPayload }),
      });

      setProgress(95);
      if (!scanRes.ok) throw new Error("The scan could not be completed. Try again shortly.");
      const scanData = await scanRes.json();

      if (scanData.results) {
        setResults(scanData.results.filter((r: any) => !r.error));
      }
      setProgress(100);
    } catch (err: any) {
      setError("Scan unavailable. " + err.message);
    } finally {
      setLoading(false);
    }
  }

  // Filter by direction
  const filtered = results.filter((r) => {
    if (dirFilter !== "all" && r.direction !== dirFilter) return false;
    return true;
  });

  // For timeframe views, filter to stocks with breakout signals on that TF
  function getTFBreakouts(tf: "daily" | "weekly" | "monthly") {
    return filtered
      .filter((r) => {
        const detail = r[tf];
        if (!detail) return false;
        return (
          detail.cpr_direction === "ascending" ||
          detail.cpr_direction === "descending" ||
          detail.cpr_width_class === "extremely_narrow" ||
          detail.cpr_width_class === "narrow"
        );
      })
      .sort((a, b) => (b[tf]?.total || 0) - (a[tf]?.total || 0));
  }

  const dailyBreakouts = getTFBreakouts("daily");
  const weeklyBreakouts = getTFBreakouts("weekly");
  const monthlyBreakouts = getTFBreakouts("monthly");

  return (
    <div className="space-y-4">
      {/* Controls row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Timeframe tabs */}
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {([
              { key: "all", label: "Overview" },
              { key: "daily", label: "Daily" },
              { key: "weekly", label: "Weekly" },
              { key: "monthly", label: "Monthly" },
            ] as { key: TFView; label: string }[]).map((t) => (
              <button
                key={t.key}
                onClick={() => setTfView(t.key)}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-medium transition-colors",
                  tfView === t.key
                    ? "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Direction filter */}
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["all", "LONG", "SHORT"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDirFilter(d)}
                className={cn(
                  "px-2.5 py-1.5 rounded text-xs font-medium transition-colors",
                  dirFilter === d
                    ? d === "LONG" ? "bg-profit text-white"
                    : d === "SHORT" ? "bg-loss text-white"
                    : "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {d === "all" ? "All" : d === "LONG" ? "Long" : "Short"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["nifty50", "nifty100", "nifty200"] as UniverseKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setUniverse(key)}
                disabled={loading}
                className={cn(
                  "px-2 py-1 rounded text-xs font-medium transition-colors",
                  universe === key
                    ? "bg-accent text-white"
                    : "text-muted hover:text-foreground disabled:opacity-50"
                )}
              >
                {UNIVERSE_META[key].shortLabel}
              </button>
            ))}
          </div>
          <button
            onClick={runScan}
            disabled={loading}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 disabled:opacity-50"
          >
            {loading ? `Scanning... ${progress}%` : `Scan ${UNIVERSE_META[universe].label}`}
          </button>
        </div>
      </div>

      {!loading && !error && results.length === 0 && <ScannerEmptyState scanned={hasScanned} />}

      {error && (
        <div role="alert" className="bg-loss-bg border border-loss/20 rounded-lg p-4 text-loss text-sm">{error}</div>
      )}

      {loading && (
        <div className="bg-card border border-card-border rounded-lg p-6 text-center">
          <div className="w-full h-2 bg-card-border/30 rounded-full mb-3 overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          <div className="animate-pulse text-accent mb-2">
            Fetching daily + weekly + monthly data... {progress}%
          </div>
        </div>
      )}

      {results.length > 0 && (
        <>
          {/* Stats */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Scanned: </span>
              <span className="font-medium">{results.length}</span>
            </div>
            <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">{results.filter((r) => r.direction === "LONG").length}</span>
              <span className="text-profit/70 ml-1">Long</span>
            </div>
            <div className="bg-loss-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-loss font-medium">{results.filter((r) => r.direction === "SHORT").length}</span>
              <span className="text-loss/70 ml-1">Short</span>
            </div>
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">{results.filter((r) => r.direction === "NEUTRAL").length} Neutral</span>
            </div>
            {tfView !== "all" && (
              <div className="bg-accent-bg border border-card-border rounded px-3 py-1.5">
                <span className="text-accent font-medium">
                  {tfView === "daily" ? dailyBreakouts.length : tfView === "weekly" ? weeklyBreakouts.length : monthlyBreakouts.length}
                </span>
                <span className="text-accent/70 ml-1">{tfView} setups</span>
              </div>
            )}
          </div>

          {/* Overview — combined table */}
          {tfView === "all" && (
            <div className="bg-card border border-card-border rounded-lg overflow-hidden">
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b border-card-border text-muted text-xs">
                      <th className="text-left px-4 py-2">Tier</th>
                      <th className="text-left px-3 py-2">Symbol</th>
                      <th className="text-right px-3 py-2">Price</th>
                      <th className="text-center px-3 py-2">Score</th>
                      <th className="text-center px-3 py-2">Direction</th>
                      <th className="text-center px-2 py-2">Monthly</th>
                      <th className="text-center px-2 py-2">Weekly</th>
                      <th className="text-center px-2 py-2">Daily</th>
                      <th className="text-right px-3 py-2">Entry</th>
                      <th className="text-right px-3 py-2">SL</th>
                      <th className="text-right px-3 py-2">Target</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {filtered.map((r) => (
                      <tr key={r.symbol} className="border-b border-card-border/50 hover:bg-hover-bg">
                        <td className="px-4 py-2">
                          <span className={cn("px-2 py-0.5 rounded text-xs font-bold", tierColors[r.alert_tier] || "")}>{r.alert_tier}</span>
                        </td>
                        <td className="px-3 py-2 font-medium text-foreground">{r.symbol}</td>
                        <td className="text-right px-3 py-2">{formatNumber(r.current_price)}</td>
                        <td className="text-center px-3 py-2">
                          <span className="font-bold">{r.total_score}</span><span className="text-muted">/12</span>
                        </td>
                        <td className="text-center px-3 py-2">
                          <span className={cn("text-xs font-medium", r.direction === "LONG" ? "text-profit" : r.direction === "SHORT" ? "text-loss" : "text-muted")}>
                            {r.direction}
                          </span>
                        </td>
                        <td className="text-center px-2 py-2">{renderTFCell(r.monthly)}</td>
                        <td className="text-center px-2 py-2">{renderTFCell(r.weekly)}</td>
                        <td className="text-center px-2 py-2">{renderTFCell(r.daily)}</td>
                        <td className="text-right px-3 py-2 text-accent">{r.entry_price ? formatNumber(r.entry_price) : "—"}</td>
                        <td className="text-right px-3 py-2 text-loss">{r.stop_loss ? formatNumber(r.stop_loss) : "—"}</td>
                        <td className="text-right px-3 py-2 text-profit">{r.target_1r2 ? formatNumber(r.target_1r2) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Timeframe-specific views */}
          {tfView === "daily" && <TFBreakoutTable title="Daily CPR Breakouts" data={dailyBreakouts} tf="daily" />}
          {tfView === "weekly" && <TFBreakoutTable title="Weekly CPR Breakouts" data={weeklyBreakouts} tf="weekly" />}
          {tfView === "monthly" && <TFBreakoutTable title="Monthly CPR Breakouts" data={monthlyBreakouts} tf="monthly" />}
        </>
      )}
    </div>
  );
}

// ── Helper: compact TF cell for overview ────────────────────────────────────

function renderTFCell(tf: TimeframeDetail | undefined) {
  if (!tf) return <span className="text-muted text-xs">—</span>;
  const dir = cprDirLabel[tf.cpr_direction] || cprDirLabel.unknown;
  const isNarrow = tf.cpr_width_class === "extremely_narrow" || tf.cpr_width_class === "narrow";
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={cn("text-xs font-medium", dir.color)}>
        {dir.icon} {tf.total}/3
      </span>
      {isNarrow && (
        <span className="text-[10px] text-accent">narrow</span>
      )}
    </div>
  );
}

// ── Timeframe Breakout Table ────────────────────────────────────────────────

function TFBreakoutTable({
  title,
  data,
  tf,
}: {
  title: string;
  data: MultiTFResult[];
  tf: "daily" | "weekly" | "monthly";
}) {
  if (!data.length) {
    return (
      <div className="bg-card border border-card-border rounded-lg p-8 text-center text-muted">
        No {tf} breakouts found
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">{title} ({data.length} stocks)</h3>
      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-card-border text-muted text-xs">
                <th className="text-left px-4 py-2">Symbol</th>
                <th className="text-right px-3 py-2">Price</th>
                <th className="text-center px-3 py-2">CPR Direction</th>
                <th className="text-center px-3 py-2">Streak</th>
                <th className="text-center px-3 py-2">Width</th>
                <th className="text-center px-3 py-2">PEMA Stack</th>
                <th className="text-center px-3 py-2">Price vs CPR</th>
                <th className="text-center px-3 py-2">TF Score</th>
                <th className="text-center px-3 py-2">Total</th>
                <th className="text-center px-3 py-2">Direction</th>
                <th className="text-right px-3 py-2">Entry</th>
                <th className="text-right px-3 py-2">SL</th>
                <th className="text-right px-3 py-2">Target</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.map((r) => {
                const detail = r[tf]!;
                const dir = cprDirLabel[detail.cpr_direction] || cprDirLabel.unknown;
                const streak = detail.cpr_direction === "ascending"
                  ? detail.consecutive_ascending
                  : detail.cpr_direction === "descending"
                  ? detail.consecutive_descending
                  : 0;

                return (
                  <tr key={r.symbol} className="border-b border-card-border/50 hover:bg-hover-bg">
                    <td className="px-4 py-2 font-medium text-foreground">{r.symbol}</td>
                    <td className="text-right px-3 py-2">{formatNumber(r.current_price)}</td>
                    <td className="text-center px-3 py-2">
                      <span className={cn("text-xs font-medium", dir.color)}>
                        {dir.icon} {dir.label}
                      </span>
                    </td>
                    <td className="text-center px-3 py-2">
                      {streak > 0 && (
                        <span className={cn("text-xs font-bold", streak >= 3 ? "text-profit" : "text-foreground")}>
                          {streak}
                        </span>
                      )}
                      {streak === 0 && <span className="text-muted text-xs">—</span>}
                    </td>
                    <td className="text-center px-3 py-2">
                      <span className={cn("text-xs px-1.5 py-0.5 rounded",
                        detail.cpr_width_class === "extremely_narrow" ? "text-profit bg-profit-bg" :
                        detail.cpr_width_class === "narrow" ? "text-accent bg-accent-bg" : "text-muted"
                      )}>
                        {detail.cpr_width_class.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="text-center px-3 py-2">
                      <span className={cn("text-xs font-medium",
                        detail.pema_stack === "bullish" ? "text-profit" :
                        detail.pema_stack === "bearish" ? "text-loss" : "text-muted"
                      )}>
                        {detail.pema_stack === "bullish" ? "Bullish" :
                         detail.pema_stack === "bearish" ? "Bearish" : "Tangled"}
                      </span>
                    </td>
                    <td className="text-center px-3 py-2">
                      <span className={cn("text-xs",
                        detail.price_vs_cpr === "above" ? "text-profit" :
                        detail.price_vs_cpr === "below" ? "text-loss" : "text-warning"
                      )}>
                        {detail.price_vs_cpr}
                      </span>
                    </td>
                    <td className="text-center px-3 py-2">
                      <span className="font-bold">{detail.total}</span><span className="text-muted">/3</span>
                    </td>
                    <td className="text-center px-3 py-2">
                      <span className="font-bold">{r.total_score}</span><span className="text-muted">/12</span>
                    </td>
                    <td className="text-center px-3 py-2">
                      <span className={cn("text-xs font-medium",
                        r.direction === "LONG" ? "text-profit" : r.direction === "SHORT" ? "text-loss" : "text-muted"
                      )}>
                        {r.direction}
                      </span>
                    </td>
                    <td className="text-right px-3 py-2 text-accent">{r.entry_price ? formatNumber(r.entry_price) : "—"}</td>
                    <td className="text-right px-3 py-2 text-loss">{r.stop_loss ? formatNumber(r.stop_loss) : "—"}</td>
                    <td className="text-right px-3 py-2 text-profit">{r.target_1r2 ? formatNumber(r.target_1r2) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
