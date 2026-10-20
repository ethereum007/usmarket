"use client";

import { ScannerEmptyState } from "./ScannerEmptyState";

import { useState } from "react";
import { formatNumber, cn } from "../../lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface BounceResult {
  symbol: string;
  current_price: number;
  low_52w: number;
  high_52w: number;
  bounce_pct: number;
  distance_from_low_pct: number;
  distance_from_high_pct: number;
  volume_ratio: number;
  trend: string;
  signal: string;
  score: number;
}

const signalColors: Record<string, { color: string; bg: string }> = {
  strong_bounce: { color: "text-profit", bg: "bg-profit-bg" },
  bounce: { color: "text-accent", bg: "bg-accent-bg" },
  weak_bounce: { color: "text-warning", bg: "bg-[rgba(255,193,7,0.1)]" },
  no_signal: { color: "text-muted", bg: "bg-transparent" },
};

export function Bounce52WScanner() {
  const [results, setResults] = useState<BounceResult[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signalFilter, setSignalFilter] = useState("all");

  async function runScan() {
    setHasScanned(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/52w-bounce`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      if (data.results) {
        setResults(data.results);
      } else if (Array.isArray(data)) {
        setResults(data);
      } else {
        setResults([]);
      }
    } catch (err: any) {
      setError("Scan unavailable. " + err.message);
    } finally {
      setLoading(false);
    }
  }

  const filtered =
    signalFilter === "all"
      ? results
      : results.filter((r) => r.signal === signalFilter);

  const strongCount = results.filter((r) => r.signal === "strong_bounce").length;
  const bounceCount = results.filter((r) => r.signal === "bounce").length;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {[
              { key: "all", label: "All" },
              { key: "strong_bounce", label: `Strong (${strongCount})` },
              { key: "bounce", label: `Bounce (${bounceCount})` },
            ].map((s) => (
              <button
                key={s.key}
                onClick={() => setSignalFilter(s.key)}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-medium transition-colors",
                  signalFilter === s.key
                    ? s.key === "strong_bounce"
                      ? "bg-profit text-white"
                      : "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={runScan}
          disabled={loading}
          className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 disabled:opacity-50"
        >
          {loading ? "Scanning..." : "Scan 52W Bounce"}
        </button>
      </div>

      <p className="text-xs text-muted">
        Finds stocks bouncing off their 52-week lows with increasing volume.
        Strong bounces indicate potential reversal setups from oversold conditions.
      </p>

      {!loading && !error && results.length === 0 && <ScannerEmptyState scanned={hasScanned} />}

      {error && (
        <div role="alert" className="bg-loss-bg border border-loss/20 rounded-lg p-4 text-loss text-sm">
          {error}
        </div>
      )}

      {loading && (
        <div className="bg-card border border-card-border rounded-lg p-6 text-center">
          <div className="animate-pulse text-accent">
            Scanning for 52-week bounce setups...
          </div>
        </div>
      )}

      {results.length > 0 && (
        <>
          {/* Stats */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Found: </span>
              <span className="font-medium">{results.length}</span>
              <span className="text-muted"> stocks</span>
            </div>
            <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">{strongCount}</span>
              <span className="text-profit/70 ml-1">Strong Bounce</span>
            </div>
            <div className="bg-accent-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-accent font-medium">{bounceCount}</span>
              <span className="text-accent/70 ml-1">Bounce</span>
            </div>
          </div>

          {/* Table */}
          <div className="bg-card border border-card-border rounded-lg overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-card-border text-muted text-xs">
                    <th className="text-center px-3 py-2">Signal</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-right px-3 py-2">Price</th>
                    <th className="text-right px-3 py-2">52W Low</th>
                    <th className="text-right px-3 py-2">52W High</th>
                    <th className="text-right px-3 py-2">Bounce %</th>
                    <th className="text-right px-3 py-2">From Low</th>
                    <th className="text-right px-3 py-2">From High</th>
                    <th className="text-center px-3 py-2">Vol Ratio</th>
                    <th className="text-center px-3 py-2">Score</th>
                    <th className="text-center px-3 py-2">Trend</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {filtered.map((r) => {
                    const sig = signalColors[r.signal] || signalColors.no_signal;
                    return (
                      <tr
                        key={r.symbol}
                        className="border-b border-card-border/50 hover:bg-hover-bg"
                      >
                        <td className="text-center px-3 py-2">
                          <span
                            className={cn(
                              "text-xs font-medium px-2 py-0.5 rounded",
                              sig.bg,
                              sig.color
                            )}
                          >
                            {r.signal.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-medium text-foreground">
                          {r.symbol}
                        </td>
                        <td className="text-right px-3 py-2">
                          {formatNumber(r.current_price)}
                        </td>
                        <td className="text-right px-3 py-2 text-loss">
                          {formatNumber(r.low_52w)}
                        </td>
                        <td className="text-right px-3 py-2 text-profit">
                          {formatNumber(r.high_52w)}
                        </td>
                        <td className="text-right px-3 py-2">
                          <span
                            className={cn(
                              "font-medium",
                              r.bounce_pct > 10
                                ? "text-profit"
                                : r.bounce_pct > 5
                                ? "text-accent"
                                : "text-muted"
                            )}
                          >
                            +{r.bounce_pct.toFixed(1)}%
                          </span>
                        </td>
                        <td className="text-right px-3 py-2 text-profit">
                          +{r.distance_from_low_pct.toFixed(1)}%
                        </td>
                        <td className="text-right px-3 py-2 text-loss">
                          {r.distance_from_high_pct.toFixed(1)}%
                        </td>
                        <td className="text-center px-3 py-2">
                          <span
                            className={cn(
                              "text-xs font-medium",
                              r.volume_ratio >= 2
                                ? "text-profit"
                                : r.volume_ratio >= 1.5
                                ? "text-accent"
                                : "text-muted"
                            )}
                          >
                            {r.volume_ratio.toFixed(1)}x
                          </span>
                        </td>
                        <td className="text-center px-3 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <div className="w-10 h-1.5 bg-card-border/30 rounded-full overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  r.score >= 70
                                    ? "bg-profit"
                                    : r.score >= 40
                                    ? "bg-accent"
                                    : "bg-muted"
                                )}
                                style={{ width: `${r.score}%` }}
                              />
                            </div>
                            <span className="text-xs w-5">{r.score}</span>
                          </div>
                        </td>
                        <td className="text-center px-3 py-2">
                          <span
                            className={cn(
                              "text-xs font-medium capitalize",
                              r.trend === "up"
                                ? "text-profit"
                                : r.trend === "down"
                                ? "text-loss"
                                : "text-muted"
                            )}
                          >
                            {r.trend}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div className="text-center py-8 text-muted">
                  No stocks match your filters
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
