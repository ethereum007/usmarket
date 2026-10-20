"use client";

import { ScannerEmptyState } from "./ScannerEmptyState";

import { useState } from "react";
import { fetchAPI } from "../../lib/api";
import { formatNumber, cn } from "../../lib/utils";
import { type UniverseKey, UNIVERSE_META, getUniverse } from "../../lib/stock-universe";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface VPResult {
  symbol: string;
  current_price: number;
  poc: number;
  vah: number;
  val: number;
  price_vs_profile: string;
  distance_to_poc_pct: number;
  total_volume: number;
  poc_near_cpr_pivot: boolean;
  vah_near_cpr_tc: boolean;
  val_near_cpr_bc: boolean;
  signal: string;
  signal_strength: number;
  notes: string[];
}

const signalConfig: Record<string, { color: string; bg: string; label: string }> = {
  confluence: { color: "text-profit", bg: "bg-profit-bg", label: "CPR Confluence" },
  bullish: { color: "text-profit", bg: "bg-profit-bg", label: "Bullish" },
  bearish: { color: "text-loss", bg: "bg-loss-bg", label: "Bearish" },
  neutral: { color: "text-muted", bg: "bg-card", label: "Neutral" },
};

const positionLabels: Record<string, { label: string; color: string }> = {
  above_value: { label: "Above Value", color: "text-profit" },
  below_value: { label: "Below Value", color: "text-loss" },
  at_poc: { label: "At POC", color: "text-accent" },
  in_value: { label: "In Value", color: "text-muted" },
};

function formatVol(v: number): string {
  if (v >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000) return `${(v / 100000).toFixed(1)}L`;
  return `${(v / 1000).toFixed(0)}K`;
}

export function VolumeProfileScanner() {
  const [universe, setUniverse] = useState<UniverseKey>("nifty50");
  const [results, setResults] = useState<VPResult[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [signalFilter, setSignalFilter] = useState("all");

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
            const res = await fetchAPI(`/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=day&days=60`);
            if (res.success && res.data.length >= 10) {
              batchPayload.push({ symbol: sym, daily: res.data, lookback: 30 });
            }
          } catch {}
        });
        await Promise.all(promises);
        if (i + BATCH_SIZE < symbols.length) await new Promise((r) => setTimeout(r, 300));
      }

      setProgress(90);
      if (!batchPayload.length) throw new Error("No usable price history was received for this universe.");
      const scanRes = await fetch(`${API_URL}/api/scanner/volume-profile`, {
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

  const filtered = signalFilter === "all" ? results : results.filter((r) => r.signal === signalFilter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {["all", "confluence", "bullish", "bearish"].map((s) => (
              <button key={s} onClick={() => setSignalFilter(s)}
                className={cn("px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize",
                  signalFilter === s ? s === "bullish" || s === "confluence" ? "bg-profit text-white" : s === "bearish" ? "bg-loss text-white" : "bg-accent text-white" : "text-muted hover:text-foreground"
                )}>
                {s === "all" ? "All" : s === "confluence" ? "CPR Confluence" : s}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["nifty50", "nifty100", "nifty200"] as UniverseKey[]).map((key) => (
              <button key={key} onClick={() => setUniverse(key)} disabled={loading}
                className={cn("px-2 py-1 rounded text-xs font-medium transition-colors", universe === key ? "bg-accent text-white" : "text-muted hover:text-foreground disabled:opacity-50")}>
                {UNIVERSE_META[key].shortLabel}
              </button>
            ))}
          </div>
          <button onClick={runScan} disabled={loading}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 disabled:opacity-50">
            {loading ? `Scanning... ${progress}%` : "Scan Volume Profile"}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted">
        Computes POC (Point of Control), VAH (Value Area High), VAL (Value Area Low) from 30-day volume distribution.
        Highlights CPR confluence when POC aligns with CPR Pivot.
      </p>

      {!loading && !error && results.length === 0 && <ScannerEmptyState scanned={hasScanned} />}

      {error && <div role="alert" className="bg-loss-bg border border-loss/20 rounded-lg p-4 text-loss text-sm">{error}</div>}
      {loading && (
        <div className="bg-card border border-card-border rounded-lg p-6 text-center">
          <div className="w-full h-2 bg-card-border/30 rounded-full mb-3 overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          <div className="animate-pulse text-accent">Building volume profiles... {progress}%</div>
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Scanned: </span><span className="font-medium">{results.length}</span>
            </div>
            <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">{results.filter((r) => r.signal === "bullish" || r.signal === "confluence").length}</span>
              <span className="text-profit/70 ml-1">Bullish / Confluence</span>
            </div>
            <div className="bg-loss-bg border border-card-border rounded px-3 py-1.5">
              <span className="text-loss font-medium">{results.filter((r) => r.signal === "bearish").length}</span>
              <span className="text-loss/70 ml-1">Bearish</span>
            </div>
          </div>

          <div className="bg-card border border-card-border rounded-lg overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-card-border text-muted text-xs">
                    <th className="text-center px-3 py-2">Signal</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-right px-3 py-2">Price</th>
                    <th className="text-center px-3 py-2">Position</th>
                    <th className="text-right px-3 py-2">VAH</th>
                    <th className="text-right px-3 py-2">POC</th>
                    <th className="text-right px-3 py-2">VAL</th>
                    <th className="text-right px-3 py-2">Dist to POC</th>
                    <th className="text-center px-3 py-2">Strength</th>
                    <th className="text-center px-2 py-2">CPR</th>
                    <th className="text-left px-3 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {filtered.map((r) => {
                    const sig = signalConfig[r.signal] || signalConfig.neutral;
                    const pos = positionLabels[r.price_vs_profile] || positionLabels.in_value;
                    return (
                      <tr key={r.symbol} className="border-b border-card-border/50 hover:bg-hover-bg">
                        <td className="text-center px-3 py-2">
                          <span className={cn("text-xs font-medium px-2 py-0.5 rounded", sig.bg, sig.color)}>{sig.label}</span>
                        </td>
                        <td className="px-3 py-2 font-medium text-foreground">{r.symbol}</td>
                        <td className="text-right px-3 py-2">{formatNumber(r.current_price)}</td>
                        <td className="text-center px-3 py-2">
                          <span className={cn("text-xs font-medium", pos.color)}>{pos.label}</span>
                        </td>
                        <td className="text-right px-3 py-2 text-loss">{formatNumber(r.vah)}</td>
                        <td className="text-right px-3 py-2 text-accent font-bold">{formatNumber(r.poc)}</td>
                        <td className="text-right px-3 py-2 text-profit">{formatNumber(r.val)}</td>
                        <td className="text-right px-3 py-2">
                          <span className={cn("text-xs", r.distance_to_poc_pct > 0 ? "text-profit" : "text-loss")}>
                            {r.distance_to_poc_pct > 0 ? "+" : ""}{r.distance_to_poc_pct}%
                          </span>
                        </td>
                        <td className="text-center px-3 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <div className="w-10 h-1.5 bg-card-border/30 rounded-full overflow-hidden">
                              <div className={cn("h-full rounded-full", r.signal_strength >= 50 ? "bg-profit" : r.signal_strength >= 30 ? "bg-accent" : "bg-muted")}
                                style={{ width: `${r.signal_strength}%` }} />
                            </div>
                            <span className="text-xs w-5">{r.signal_strength}</span>
                          </div>
                        </td>
                        <td className="text-center px-2 py-2">
                          {r.poc_near_cpr_pivot && <span className="text-profit text-xs font-bold" title="POC near CPR Pivot">P</span>}
                          {r.vah_near_cpr_tc && <span className="text-loss text-xs font-bold ml-0.5" title="VAH near CPR Top">T</span>}
                          {r.val_near_cpr_bc && <span className="text-profit text-xs font-bold ml-0.5" title="VAL near CPR Bottom">B</span>}
                          {!r.poc_near_cpr_pivot && !r.vah_near_cpr_tc && !r.val_near_cpr_bc && <span className="text-muted text-xs">—</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted max-w-[200px] truncate">{r.notes[0] || "—"}</td>
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
