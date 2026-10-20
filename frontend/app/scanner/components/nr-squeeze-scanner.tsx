"use client";

import { ScannerEmptyState } from "./ScannerEmptyState";

import { useState } from "react";
import { fetchAPI } from "../../lib/api";
import { formatNumber, cn } from "../../lib/utils";
import { type UniverseKey, UNIVERSE_META, getUniverse } from "../../lib/stock-universe";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface NRResult {
  symbol: string;
  current_price: number;
  is_nr4: boolean;
  is_nr7: boolean;
  is_inside_bar: boolean;
  nr_bar_high: number;
  nr_bar_low: number;
  nr_bar_range: number;
  nr_bar_range_pct: number;
  avg_range_7d: number;
  bb_squeeze: boolean;
  bb_width_pct: number;
  bb_width_percentile: number;
  direction: string;
  close_position: number;
  trend_bias: string;
  volume_signal: string;
  buy_above: number;
  sell_below: number;
  long_sl: number;
  short_sl: number;
  long_target: number;
  short_target: number;
  squeeze_score: number;
  squeeze_type: string;
  notes: string[];
}

const typeColors: Record<string, { color: string; bg: string }> = {
  "NR7+IB": { color: "text-profit", bg: "bg-profit-bg" },
  NR7: { color: "text-profit", bg: "bg-profit-bg" },
  "NR4+IB": { color: "text-accent", bg: "bg-accent-bg" },
  NR4: { color: "text-accent", bg: "bg-accent-bg" },
  None: { color: "text-muted", bg: "bg-transparent" },
};

export function NRSqueezeScanner() {
  const [universe, setUniverse] = useState<UniverseKey>("nifty50");
  const [results, setResults] = useState<NRResult[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [dirFilter, setDirFilter] = useState<"all" | "bullish" | "bearish">("all");
  const [typeFilter, setTypeFilter] = useState("all");

  async function runScan() {
    setHasScanned(true);
    setLoading(true);
    setError(null);
    setProgress(0);
    const symbols = getUniverse(universe);

    try {
      const batchPayload: any[] = [];
      const BATCH_SIZE = 5;

      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        setProgress(Math.round((i / symbols.length) * 80));
        const promises = batch.map(async (sym) => {
          try {
            const res = await fetchAPI(`/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=day&days=30`);
            if (res.success && res.data.length >= 10) {
              batchPayload.push({ symbol: sym, daily: res.data });
            }
          } catch {}
        });
        await Promise.all(promises);
        if (i + BATCH_SIZE < symbols.length) await new Promise((r) => setTimeout(r, 200));
      }

      setProgress(90);
      if (!batchPayload.length) throw new Error("No usable price history was received for this universe.");
      const scanRes = await fetch(`${API_URL}/api/scanner/nr-squeeze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: batchPayload }),
      });
      if (!scanRes.ok) throw new Error("The scan could not be completed. Try again shortly.");
      const data = await scanRes.json();
      if (data.results) setResults(data.results.filter((r: any) => !r.error));
      setProgress(100);
    } catch (err: any) {
      setError("Scan unavailable. " + err.message);
    } finally {
      setLoading(false);
    }
  }

  const filtered = results.filter((r) => {
    if (dirFilter !== "all" && r.direction !== dirFilter) return false;
    if (typeFilter === "nr7" && !r.is_nr7) return false;
    if (typeFilter === "nr4" && !r.is_nr4) return false;
    if (typeFilter === "ib" && !r.is_inside_bar) return false;
    if (typeFilter === "bb" && !r.bb_squeeze) return false;
    return true;
  });

  const nr7Count = results.filter((r) => r.is_nr7).length;
  const nr4Count = results.filter((r) => r.is_nr4 && !r.is_nr7).length;
  const ibCount = results.filter((r) => r.is_inside_bar).length;
  const bbCount = results.filter((r) => r.bb_squeeze).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Direction */}
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["all", "bullish", "bearish"] as const).map((d) => (
              <button key={d} onClick={() => setDirFilter(d)}
                className={cn("px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize",
                  dirFilter === d ? d === "bullish" ? "bg-profit text-white" : d === "bearish" ? "bg-loss text-white" : "bg-accent text-white" : "text-muted hover:text-foreground"
                )}>
                {d === "all" ? "All" : d}
              </button>
            ))}
          </div>
          {/* Type filter */}
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {[
              { key: "all", label: "All" },
              { key: "nr7", label: `NR7 (${nr7Count})` },
              { key: "nr4", label: `NR4 (${nr4Count})` },
              { key: "ib", label: `IB (${ibCount})` },
              { key: "bb", label: `BB (${bbCount})` },
            ].map((t) => (
              <button key={t.key} onClick={() => setTypeFilter(t.key)}
                className={cn("px-2 py-1.5 rounded text-xs font-medium transition-colors",
                  typeFilter === t.key ? "bg-accent text-white" : "text-muted hover:text-foreground"
                )}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["nifty50", "nifty100", "nifty200", "nifty500"] as UniverseKey[]).map((key) => (
              <button key={key} onClick={() => setUniverse(key)} disabled={loading}
                className={cn("px-2 py-1 rounded text-xs font-medium transition-colors", universe === key ? "bg-accent text-white" : "text-muted hover:text-foreground disabled:opacity-50")}>
                {UNIVERSE_META[key].shortLabel}
              </button>
            ))}
          </div>
          <button onClick={runScan} disabled={loading}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 disabled:opacity-50">
            {loading ? `Scanning... ${progress}%` : "Scan NR Squeeze"}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted">
        Finds stocks with the narrowest range in 4/7 days (NR4/NR7), Inside Bars, and Bollinger Band squeezes.
        Volatility compression = big move incoming. Entry above NR high (long) or below NR low (short).
      </p>

      {!loading && !error && results.length === 0 && <ScannerEmptyState scanned={hasScanned} />}

      {error && <div role="alert" className="bg-loss-bg border border-loss/20 rounded-lg p-4 text-loss text-sm">{error}</div>}
      {loading && (
        <div className="bg-card border border-card-border rounded-lg p-6 text-center">
          <div className="w-full h-2 bg-card-border/30 rounded-full mb-3 overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          <div className="animate-pulse text-accent">Scanning for NR squeezes... {progress}%</div>
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Found: </span><span className="font-medium">{results.length}</span><span className="text-muted"> squeeze setups</span>
            </div>
            <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">{results.filter((r) => r.direction === "bullish").length}</span>
              <span className="text-profit/70 ml-1">Bullish</span>
            </div>
            <div className="bg-loss-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-loss font-medium">{results.filter((r) => r.direction === "bearish").length}</span>
              <span className="text-loss/70 ml-1">Bearish</span>
            </div>
          </div>

          <div className="bg-card border border-card-border rounded-lg overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-card-border text-muted text-xs">
                    <th className="text-center px-3 py-2">Type</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-right px-3 py-2">Price</th>
                    <th className="text-center px-3 py-2">Score</th>
                    <th className="text-center px-3 py-2">Direction</th>
                    <th className="text-right px-3 py-2">NR Range</th>
                    <th className="text-center px-2 py-2">IB</th>
                    <th className="text-center px-2 py-2">BB</th>
                    <th className="text-center px-2 py-2">Vol</th>
                    <th className="text-right px-3 py-2">Buy Above</th>
                    <th className="text-right px-3 py-2">Sell Below</th>
                    <th className="text-right px-3 py-2">Long Target</th>
                    <th className="text-right px-3 py-2">Short Target</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {filtered.map((r) => {
                    const tc = typeColors[r.squeeze_type] || typeColors.None;
                    return (
                      <tr key={r.symbol} className="border-b border-card-border/50 hover:bg-hover-bg">
                        <td className="text-center px-3 py-2">
                          <span className={cn("text-xs font-bold px-2 py-0.5 rounded", tc.bg, tc.color)}>{r.squeeze_type}</span>
                        </td>
                        <td className="px-3 py-2 font-medium text-foreground">{r.symbol}</td>
                        <td className="text-right px-3 py-2">{formatNumber(r.current_price)}</td>
                        <td className="text-center px-3 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <div className="w-10 h-1.5 bg-card-border/30 rounded-full overflow-hidden">
                              <div className={cn("h-full rounded-full", r.squeeze_score >= 60 ? "bg-profit" : r.squeeze_score >= 35 ? "bg-accent" : "bg-muted")}
                                style={{ width: `${r.squeeze_score}%` }} />
                            </div>
                            <span className="text-xs w-5">{r.squeeze_score}</span>
                          </div>
                        </td>
                        <td className="text-center px-3 py-2">
                          <span className={cn("text-xs font-medium capitalize",
                            r.direction === "bullish" ? "text-profit" : r.direction === "bearish" ? "text-loss" : "text-muted"
                          )}>{r.direction}</span>
                        </td>
                        <td className="text-right px-3 py-2 text-muted">{r.nr_bar_range_pct}%</td>
                        <td className="text-center px-2 py-2">
                          {r.is_inside_bar ? <span className="text-profit text-xs font-bold">Yes</span> : <span className="text-muted text-xs">—</span>}
                        </td>
                        <td className="text-center px-2 py-2">
                          {r.bb_squeeze ? <span className="text-profit text-xs font-bold">Yes</span> : <span className="text-muted text-xs">—</span>}
                        </td>
                        <td className="text-center px-2 py-2">
                          <span className={cn("text-xs",
                            r.volume_signal === "dry" ? "text-profit" : r.volume_signal === "spike" ? "text-accent" : "text-muted"
                          )}>{r.volume_signal === "dry" ? "Dry" : r.volume_signal === "spike" ? "Spike" : "—"}</span>
                        </td>
                        <td className="text-right px-3 py-2 text-profit font-medium">{formatNumber(r.buy_above)}</td>
                        <td className="text-right px-3 py-2 text-loss font-medium">{formatNumber(r.sell_below)}</td>
                        <td className="text-right px-3 py-2 text-profit">{formatNumber(r.long_target)}</td>
                        <td className="text-right px-3 py-2 text-loss">{formatNumber(r.short_target)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
