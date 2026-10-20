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

interface DetectedPattern {
  pattern: string;
  confidence: number;
  direction: "bullish" | "bearish";
  entry_price: number;
  stop_loss: number;
  target: number;
  risk_reward: number;
  support_level: number;
  resistance_level: number;
  notes: string;
  timeframe: string;
}

interface PatternResult {
  symbol: string;
  current_price: number;
  pattern_count: number;
  patterns: DetectedPattern[];
}

const patternColors: Record<string, string> = {
  bullish: "text-profit bg-profit-bg",
  bearish: "text-loss bg-loss-bg",
};

const confidenceColor = (c: number) =>
  c >= 70 ? "text-profit" : c >= 50 ? "text-accent" : "text-muted";

export function PatternScanner() {
  const [universe, setUniverse] = useState<UniverseKey>("nifty50");
  const [results, setResults] = useState<PatternResult[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [includeWeekly, setIncludeWeekly] = useState(false);
  const [dirFilter, setDirFilter] = useState<"all" | "bullish" | "bearish">("all");
  const [patternFilter, setPatternFilter] = useState("All");

  async function runScan() {
    setHasScanned(true);
    setLoading(true);
    setError(null);
    setProgress(0);

    const symbols = getUniverse(universe);
    let completedBatches = 0;
    let failedBatches = 0;

    try {
      const BATCH_SIZE = 10;
      const allResults: PatternResult[] = [];

      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        setProgress(Math.round((i / symbols.length) * 80));

        // Fetch data for this batch
        const batchPayload: any[] = [];

        for (const sym of batch) {
          try {
            const fetches = [
              fetchAPI(`/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=day&days=120`),
            ];
            if (includeWeekly) {
              fetches.push(
                fetchAPI(`/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=week&days=420`).catch(() => ({ success: false, data: [] }))
              );
            }

            const [daily, weekly] = await Promise.all(fetches);

            if (daily.success && daily.data.length > 20) {
              batchPayload.push({
                symbol: sym,
                daily: daily.data,
                weekly: weekly?.success && weekly.data?.length > 0 ? weekly.data : null,
                lookback: 60,
                min_confidence: 40,
              });
            }
          } catch {}
        }

        // Send batch to pattern engine
        if (batchPayload.length > 0) {
          try {
            const res = await fetch(`${API_URL}/api/scanner/patterns`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ symbols: batchPayload }),
            });
            if (!res.ok) throw new Error("Scan request failed");
            const data = await res.json();
            if (!Array.isArray(data.results)) throw new Error("No scan results received");
            completedBatches += 1;
            if (data.results) {
              allResults.push(
                ...data.results.filter((r: any) => r.pattern_count > 0)
              );
            }
          } catch { failedBatches += 1; }
        }

        if (i + BATCH_SIZE < symbols.length) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      setProgress(100);
      if (!completedBatches) throw new Error("No usable scan data was received for this universe.");
      if (failedBatches) setError("Some scan batches were unavailable. Results may be incomplete.");
      // Sort by highest confidence pattern
      allResults.sort((a, b) => {
        const aMax = a.patterns[0]?.confidence || 0;
        const bMax = b.patterns[0]?.confidence || 0;
        return bMax - aMax;
      });
      setResults(allResults);
    } catch (err: any) {
      setError("Scan unavailable. " + err.message);
    } finally {
      setLoading(false);
    }
  }

  // Show only the best (highest confidence) pattern per stock
  const bestPerStock = results.map((r) => {
    if (!r.patterns.length) return null;
    const best = r.patterns[0]; // already sorted by confidence desc from backend
    return { ...best, symbol: r.symbol, current_price: r.current_price, totalPatterns: r.pattern_count };
  }).filter(Boolean) as (DetectedPattern & { symbol: string; current_price: number; totalPatterns: number })[];

  // Also keep full list for "All Patterns" view
  const flatPatterns = results.flatMap((r) =>
    r.patterns.map((p) => ({ ...p, symbol: r.symbol, current_price: r.current_price, totalPatterns: r.pattern_count }))
  );

  const [showAll, setShowAll] = useState(false);
  const sourcePatterns = showAll ? flatPatterns : bestPerStock;

  const filteredPatterns = sourcePatterns.filter((p) => {
    if (dirFilter !== "all" && p.direction !== dirFilter) return false;
    if (patternFilter !== "All" && p.pattern !== patternFilter) return false;
    return true;
  });

  const uniquePatterns = [...new Set(flatPatterns.map((p) => p.pattern))];

  const totalPatterns = flatPatterns.length;
  const bullishCount = bestPerStock.filter((p) => p.direction === "bullish").length;
  const bearishCount = bestPerStock.filter((p) => p.direction === "bearish").length;

  return (
    <div className="space-y-4">
      {/* Row 1: Direction filter + scan controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Direction filter — prominent at top */}
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["all", "bullish", "bearish"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDirFilter(d)}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize",
                  dirFilter === d
                    ? d === "bullish" ? "bg-profit text-white"
                    : d === "bearish" ? "bg-loss text-white"
                    : "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {d === "all" ? "All" : d === "bullish" ? "Bullish" : "Bearish"}
              </button>
            ))}
          </div>
          <select
            value={patternFilter}
            onChange={(e) => setPatternFilter(e.target.value)}
            className="bg-card border border-card-border rounded px-2 py-1.5 text-xs text-foreground"
          >
            <option value="All">All Patterns</option>
            {uniquePatterns.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
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
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={includeWeekly}
              onChange={(e) => setIncludeWeekly(e.target.checked)}
              className="accent-accent"
            />
            +Weekly
          </label>
          <button
            onClick={runScan}
            disabled={loading}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 disabled:opacity-50"
          >
            {loading ? `Scanning... ${progress}%` : `Scan Patterns`}
          </button>
        </div>
      </div>

      {!loading && !error && totalPatterns === 0 && <ScannerEmptyState scanned={hasScanned} />}

      {error && (
        <div role="alert" className="bg-loss-bg border border-loss/20 rounded-lg p-4 text-loss text-sm">
          {error}
        </div>
      )}

      {loading && (
        <div className="bg-card border border-card-border rounded-lg p-6 text-center">
          <div className="w-full h-2 bg-card-border/30 rounded-full mb-3 overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="animate-pulse text-accent mb-2">
            Detecting chart patterns... {progress}%
          </div>
        </div>
      )}

      {totalPatterns > 0 && (
        <>
          {/* Stats */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Stocks with patterns: </span>
              <span className="font-medium">{bestPerStock.length}</span>
              <span className="text-muted"> ({totalPatterns} total patterns)</span>
            </div>
            <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">{bullishCount}</span>
              <span className="text-profit/70 ml-1">Bullish</span>
            </div>
            <div className="bg-loss-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-loss font-medium">{bearishCount}</span>
              <span className="text-loss/70 ml-1">Bearish</span>
            </div>
          </div>

          {/* View toggle */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowAll(!showAll)}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium border transition-colors",
                showAll
                  ? "bg-accent text-white border-accent"
                  : "border-card-border text-muted hover:text-foreground"
              )}
            >
              {showAll ? "Showing All Patterns" : "Best Per Stock"}
            </button>
            <span className="text-xs text-muted">
              {filteredPatterns.length} results
            </span>
          </div>

          {/* Table */}
          <div className="bg-card border border-card-border rounded-lg overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-card-border text-muted text-xs">
                    <th className="text-left px-4 py-2">Symbol</th>
                    <th className="text-left px-3 py-2">Pattern</th>
                    <th className="text-center px-3 py-2">Confidence</th>
                    <th className="text-center px-3 py-2">Direction</th>
                    <th className="text-center px-2 py-2">TF</th>
                    <th className="text-right px-3 py-2">Entry</th>
                    <th className="text-right px-3 py-2">SL</th>
                    <th className="text-right px-3 py-2">Target</th>
                    <th className="text-center px-3 py-2">R:R</th>
                    <th className="text-left px-3 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {filteredPatterns.map((p, idx) => (
                    <tr
                      key={`${p.symbol}-${p.pattern}-${idx}`}
                      className="border-b border-card-border/50 hover:bg-hover-bg"
                    >
                      <td className="px-4 py-2 font-medium text-foreground">
                        {p.symbol}
                      </td>
                      <td className="px-3 py-2 text-xs">{p.pattern}</td>
                      <td className="text-center px-3 py-2">
                        <div className="flex items-center justify-center gap-1">
                          <div className="w-10 h-1.5 bg-card-border/30 rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full",
                                p.confidence >= 70
                                  ? "bg-profit"
                                  : p.confidence >= 50
                                  ? "bg-accent"
                                  : "bg-muted"
                              )}
                              style={{ width: `${p.confidence}%` }}
                            />
                          </div>
                          <span className={cn("text-xs", confidenceColor(p.confidence))}>
                            {p.confidence}
                          </span>
                        </div>
                      </td>
                      <td className="text-center px-3 py-2">
                        <span
                          className={cn(
                            "text-xs font-medium px-1.5 py-0.5 rounded capitalize",
                            patternColors[p.direction] || ""
                          )}
                        >
                          {p.direction}
                        </span>
                      </td>
                      <td className="text-center px-2 py-2 text-xs text-muted capitalize">
                        {p.timeframe?.charAt(0).toUpperCase() || "D"}
                      </td>
                      <td className="text-right px-3 py-2 text-accent">
                        {formatNumber(p.entry_price)}
                      </td>
                      <td className="text-right px-3 py-2 text-loss">
                        {formatNumber(p.stop_loss)}
                      </td>
                      <td className="text-right px-3 py-2 text-profit">
                        {formatNumber(p.target)}
                      </td>
                      <td className="text-center px-3 py-2">
                        <span
                          className={cn(
                            "text-xs font-medium",
                            p.risk_reward >= 2
                              ? "text-profit"
                              : p.risk_reward >= 1.5
                              ? "text-accent"
                              : "text-muted"
                          )}
                        >
                          1:{p.risk_reward.toFixed(1)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted max-w-[200px] truncate">
                        {p.notes}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredPatterns.length === 0 && (
                <div className="text-center py-8 text-muted">
                  No patterns match your filters
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
