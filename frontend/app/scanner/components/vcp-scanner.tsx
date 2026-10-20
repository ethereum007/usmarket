"use client";

import { ScannerEmptyState } from "./ScannerEmptyState";

import { useState, Fragment } from "react";
import { fetchAPI } from "../../lib/api";
import { formatNumber, cn } from "../../lib/utils";
import {
  type UniverseKey,
  UNIVERSE_META,
  getUniverse,
} from "../../lib/stock-universe";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface ContractionData {
  number: number;
  depth_pct: number;
  high: number;
  low: number;
  duration: number;
}

interface VCPResult {
  symbol: string;
  current_price: number;
  vcp_score: number;
  stage: string;
  vcp_detected: boolean;
  trend_template_pass: boolean;
  price_above_150ma: boolean;
  price_above_200ma: boolean;
  ma150_above_200ma: boolean;
  ma200_rising: boolean;
  pct_from_52w_high: number;
  pct_from_52w_low: number;
  num_contractions: number;
  contractions: ContractionData[];
  volume_declining: boolean;
  tightening: boolean;
  pivot_price: number;
  pivot_distance_pct: number;
  pivot_tight_range_pct: number;
  rs_vs_index: number;
  notes: string[];
  error?: string;
}

const stageConfig: Record<string, { color: string; bg: string }> = {
  Breakout: { color: "text-profit", bg: "bg-profit-bg" },
  "Near Pivot": { color: "text-accent", bg: "bg-accent-bg" },
  "Setting Up": { color: "text-warning", bg: "bg-[rgba(255,193,7,0.1)]" },
  "Not Ready": { color: "text-muted", bg: "bg-transparent" },
};

export function VCPScanner() {
  const [universe, setUniverse] = useState<UniverseKey>("nifty50");
  const [results, setResults] = useState<VCPResult[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stageFilter, setStageFilter] = useState("All");
  const [showTrendOnly, setShowTrendOnly] = useState(false);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  async function runScan() {
    setHasScanned(true);
    setLoading(true);
    setError(null);
    setProgress(0);

    const symbols = getUniverse(universe);

    try {
      // First get index change for RS calculation
      let indexChange = 0;
      try {
        const idxRes = await fetchAPI("/api/quotes/history?symbol=NIFTY%2050&interval=day&days=63");
        if (idxRes.success && idxRes.data.length >= 2) {
          const first = idxRes.data[0].close;
          const last = idxRes.data[idxRes.data.length - 1].close;
          indexChange = ((last - first) / first) * 100;
        }
      } catch {}

      const batchPayload: any[] = [];
      const BATCH_SIZE = 5;

      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        setProgress(Math.round((i / symbols.length) * 80));

        const promises = batch.map(async (sym) => {
          try {
            // Need 252 days (1 year) for 52-week high/low + 200 MA
            const res = await fetchAPI(
              `/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=day&days=300`
            );
            if (res.success && res.data.length >= 50) {
              batchPayload.push({
                symbol: sym,
                daily: res.data,
                index_change_pct: indexChange,
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

      // Send to VCP engine
      if (!batchPayload.length) throw new Error("No usable price history was received for this universe.");
      const scanRes = await fetch(`${API_URL}/api/scanner/vcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbols: batchPayload,
          index_change_pct: indexChange,
        }),
      });

      setProgress(95);
      if (!scanRes.ok) throw new Error("The scan could not be completed. Try again shortly.");
      const scanData = await scanRes.json();

      if (scanData.results) {
        setResults(scanData.results.filter((r: any) => !r.error));
      }
      setProgress(100);
    } catch (err: any) {
      setError("VCP Scan unavailable. " + err.message);
    } finally {
      setLoading(false);
    }
  }

  // "Ready to Trade" = passes ALL Minervini criteria
  function isReadyToTrade(r: VCPResult): boolean {
    return (
      r.trend_template_pass &&
      r.num_contractions >= 2 &&
      r.tightening &&
      r.volume_declining &&
      r.pct_from_52w_high >= -15 &&
      r.rs_vs_index > 0 &&
      r.pivot_distance_pct >= -5 && r.pivot_distance_pct <= 5
    );
  }

  // Filter
  let filtered = results;
  if (stageFilter === "Ready") {
    filtered = filtered.filter(isReadyToTrade);
  } else if (stageFilter !== "All") {
    filtered = filtered.filter((r) => r.stage === stageFilter);
  }
  if (showTrendOnly) {
    filtered = filtered.filter((r) => r.trend_template_pass);
  }

  const stageCounts = results.reduce((acc, r) => {
    acc[r.stage] = (acc[r.stage] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const readyCount = results.filter(isReadyToTrade).length;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Stage filter */}
          {/* Ready to Trade — prominent first */}
          <button
            onClick={() => setStageFilter(stageFilter === "Ready" ? "All" : "Ready")}
            className={cn(
              "px-3 py-1.5 rounded text-xs font-bold border-2 transition-colors",
              stageFilter === "Ready"
                ? "bg-profit text-white border-profit"
                : "border-profit text-profit hover:bg-profit hover:text-white"
            )}
          >
            Ready to Trade{readyCount > 0 ? ` (${readyCount})` : ""}
          </button>
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {["All", "Breakout", "Near Pivot", "Setting Up"].map((s) => (
              <button
                key={s}
                onClick={() => setStageFilter(s)}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-medium transition-colors",
                  stageFilter === s
                    ? s === "Breakout" ? "bg-profit text-white"
                    : s === "Near Pivot" ? "bg-accent text-white"
                    : "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {s}
                {s !== "All" && stageCounts[s] ? ` (${stageCounts[s]})` : s === "All" ? ` (${results.length})` : ""}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={showTrendOnly}
              onChange={(e) => setShowTrendOnly(e.target.checked)}
              className="accent-accent"
            />
            Trend Template Only
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["nifty50", "nifty100", "nifty200", "nifty500", "smallcap"] as UniverseKey[]).map((key) => (
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
            {loading ? `Scanning... ${progress}%` : `Scan VCP`}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted">
        Minervini SEPA — finds stocks with tightening contractions, declining volume, and strong trend template.
        Scores 0-100 based on trend, contractions, volume dry-up, pivot proximity, and relative strength.
      </p>

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
            Fetching 300 days of data per stock for VCP analysis... {progress}%
          </div>
        </div>
      )}

      {results.length > 0 && (
        <>
          {/* Summary */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Scanned: </span><span className="font-medium">{results.length}</span>
            </div>
            <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">{results.filter((r) => r.trend_template_pass).length}</span>
              <span className="text-profit/70 ml-1">Pass Trend Template</span>
            </div>
            <div className="bg-accent-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-accent font-medium">{results.filter((r) => r.vcp_detected).length}</span>
              <span className="text-accent/70 ml-1">VCP Detected</span>
            </div>
            {(stageCounts["Near Pivot"] || 0) + (stageCounts["Breakout"] || 0) > 0 && (
              <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
                <span className="text-profit font-medium">
                  {(stageCounts["Near Pivot"] || 0) + (stageCounts["Breakout"] || 0)}
                </span>
                <span className="text-profit/70 ml-1">Actionable</span>
              </div>
            )}
          </div>

          {/* Table */}
          <div className="bg-card border border-card-border rounded-lg overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-card-border text-muted text-xs">
                    <th className="text-center px-3 py-2">Stage</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-right px-3 py-2">Price</th>
                    <th className="text-center px-3 py-2">Score</th>
                    <th className="text-center px-2 py-2">Trend</th>
                    <th className="text-center px-3 py-2">Contractions</th>
                    <th className="text-center px-2 py-2">Vol Dry</th>
                    <th className="text-right px-3 py-2">Pivot</th>
                    <th className="text-right px-3 py-2">Dist</th>
                    <th className="text-right px-3 py-2">52W High</th>
                    <th className="text-right px-3 py-2">RS</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {filtered.map((r) => {
                    const sc = stageConfig[r.stage] || stageConfig["Not Ready"];
                    const isExpanded = expandedSymbol === r.symbol;

                    return (
                      <Fragment key={r.symbol}>
                        <tr
                          className={cn(
                            "border-b border-card-border/50 hover:bg-hover-bg cursor-pointer",
                            r.stage === "Near Pivot" || r.stage === "Breakout" ? "bg-hover-bg" : ""
                          )}
                          onClick={() => setExpandedSymbol(isExpanded ? null : r.symbol)}
                        >
                          <td className="text-center px-3 py-2">
                            <span className={cn("text-xs font-medium px-2 py-0.5 rounded", sc.bg, sc.color)}>
                              {r.stage}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-medium text-foreground">{r.symbol}</td>
                          <td className="text-right px-3 py-2">{formatNumber(r.current_price)}</td>
                          <td className="text-center px-3 py-2">
                            <div className="flex items-center justify-center gap-1">
                              <div className="w-12 h-1.5 bg-card-border/30 rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full",
                                    r.vcp_score >= 70 ? "bg-profit" :
                                    r.vcp_score >= 40 ? "bg-accent" : "bg-muted"
                                  )}
                                  style={{ width: `${r.vcp_score}%` }}
                                />
                              </div>
                              <span className="text-xs w-6">{r.vcp_score}</span>
                            </div>
                          </td>
                          <td className="text-center px-2 py-2">
                            {r.trend_template_pass ? (
                              <span className="text-profit text-xs font-bold">PASS</span>
                            ) : (
                              <span className="text-loss text-xs">FAIL</span>
                            )}
                          </td>
                          <td className="text-center px-3 py-2">
                            <div className="flex items-center justify-center gap-1">
                              <span className={cn("font-bold text-xs",
                                r.num_contractions >= 3 ? "text-profit" :
                                r.num_contractions >= 2 ? "text-accent" : "text-muted"
                              )}>
                                {r.num_contractions}
                              </span>
                              {r.tightening && <span className="text-[10px] text-profit">tight</span>}
                            </div>
                          </td>
                          <td className="text-center px-2 py-2">
                            {r.volume_declining ? (
                              <span className="text-profit text-xs">Yes</span>
                            ) : (
                              <span className="text-muted text-xs">No</span>
                            )}
                          </td>
                          <td className="text-right px-3 py-2 text-accent">{formatNumber(r.pivot_price)}</td>
                          <td className="text-right px-3 py-2">
                            <span className={cn("text-xs font-medium",
                              r.pivot_distance_pct >= 0 ? "text-profit" :
                              r.pivot_distance_pct >= -3 ? "text-accent" : "text-muted"
                            )}>
                              {r.pivot_distance_pct > 0 ? "+" : ""}{r.pivot_distance_pct}%
                            </span>
                          </td>
                          <td className="text-right px-3 py-2 text-muted">
                            {r.pct_from_52w_high}%
                          </td>
                          <td className="text-right px-3 py-2">
                            <span className={cn("text-xs font-medium",
                              r.rs_vs_index > 10 ? "text-profit" :
                              r.rs_vs_index > 0 ? "text-accent" : "text-loss"
                            )}>
                              {r.rs_vs_index > 0 ? "+" : ""}{r.rs_vs_index}
                            </span>
                          </td>
                        </tr>

                        {/* Expanded detail row */}
                        {isExpanded && (
                          <tr className="border-b border-card-border/50">
                            <td colSpan={11} className="px-4 py-3 bg-hover-bg">
                              <div className="grid grid-cols-3 gap-4">
                                {/* Contractions */}
                                <div>
                                  <div className="text-xs font-medium text-muted mb-1.5">Contractions</div>
                                  {r.contractions.length > 0 ? (
                                    <div className="flex items-end gap-2">
                                      {r.contractions.map((c) => (
                                        <div key={c.number} className="flex flex-col items-center gap-1">
                                          <div
                                            className="w-8 bg-loss/30 rounded-t"
                                            style={{ height: `${Math.max(8, c.depth_pct * 3)}px` }}
                                          />
                                          <span className="text-[10px] text-loss font-mono">
                                            -{c.depth_pct}%
                                          </span>
                                          <span className="text-[10px] text-muted">
                                            #{c.number}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted">No contractions detected</span>
                                  )}
                                </div>

                                {/* Minervini Checklist */}
                                <div>
                                  <div className="text-xs font-medium text-muted mb-1.5">Minervini Checklist</div>
                                  <ul className="space-y-0.5">
                                    {[
                                      { pass: r.trend_template_pass, label: "Trend Template (P > 150MA > 200MA, 200MA rising)" },
                                      { pass: r.num_contractions >= 2 && r.tightening, label: `2+ tightening contractions (${r.num_contractions} found)` },
                                      { pass: r.volume_declining, label: "Volume declining through base" },
                                      { pass: r.pct_from_52w_high >= -15, label: `Within 15% of 52W high (${r.pct_from_52w_high}%)` },
                                      { pass: r.pct_from_52w_low >= 30, label: `30%+ above 52W low (${r.pct_from_52w_low.toFixed(0)}%)` },
                                      { pass: r.rs_vs_index > 0, label: `Positive RS vs Nifty (${r.rs_vs_index > 0 ? "+" : ""}${r.rs_vs_index})` },
                                      { pass: r.pivot_distance_pct >= -5 && r.pivot_distance_pct <= 5, label: `Near pivot ${r.pivot_price} (${r.pivot_distance_pct > 0 ? "+" : ""}${r.pivot_distance_pct}%)` },
                                    ].map((item, i) => (
                                      <li key={i} className="text-xs flex items-start gap-1.5">
                                        <span className={cn("mt-0.5 shrink-0 font-bold", item.pass ? "text-profit" : "text-loss")}>
                                          {item.pass ? "PASS" : "FAIL"}
                                        </span>
                                        <span className="text-muted">{item.label}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  {isReadyToTrade(r) && (
                                    <div className="mt-2 px-2 py-1 bg-profit-bg border border-profit/20 rounded text-xs text-profit font-medium">
                                      All criteria met — Ready to Trade
                                    </div>
                                  )}
                                </div>

                                {/* Notes */}
                                <div>
                                  <div className="text-xs font-medium text-muted mb-1.5">Analysis</div>
                                  <ul className="space-y-0.5">
                                    {r.notes.map((note, i) => (
                                      <li key={i} className="text-xs text-muted flex items-start gap-1.5">
                                        <span className="text-accent mt-0.5 shrink-0">-</span>
                                        {note}
                                      </li>
                                    ))}
                                  </ul>
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
              {filtered.length === 0 && (
                <div className="text-center py-8 text-muted">No stocks match the selected filters</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
