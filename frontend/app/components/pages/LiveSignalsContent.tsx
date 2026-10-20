"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { fetchAPI } from "../../lib/api";

interface LiveSignalData {
  pdhCrossCount: number;
  comboSurgeCount: number;
  pdlCrossCount: number;
  comboSellCount: number;
  pdhCrossed: string[];
  comboSurge: string[];
  pdlCrossed: string[];
  comboSell: string[];
  firstCrossTime: Record<string, string>;
  firstComboTime: Record<string, string>;
  firstPDLTime: Record<string, string>;
  firstComboSellTime: Record<string, string>;
  cached?: boolean;
  cachedAt?: string;
  timestamp: number;
}

const CACHE_KEY = "alpha-radar:live-signals";

function decisionHref(symbol: string) {
  return `/radar-trade?symbol=${encodeURIComponent(symbol)}`;
}

export default function LiveSignalsContent() {
  const [data, setData] = useState<LiveSignalData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetchAPI<LiveSignalData>("/api/signals/live-signals");
      setData(res);
      window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(res));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    const cached = window.sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      try { setData(JSON.parse(cached)); } catch {}
      setLoading(false);
      return;
    }
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="bg-card border border-card-border rounded-xl p-12 text-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-foreground font-medium">Loading live signals...</p>
      </div>
    );
  }

  const pdhCount = data?.pdhCrossCount || 0;
  const comboCount = data?.comboSurgeCount || 0;
  const pdlCount = data?.pdlCrossCount || 0;
  const comboSellCount = data?.comboSellCount || 0;

  return (
    <div className="space-y-5">
      {data?.cached && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg px-4 py-2 text-xs text-warning flex items-center gap-2">
          <span>📋</span>
          <span>Showing last session data {data.cachedAt ? `from ${new Date(data.cachedAt).toLocaleString("en-IN")}` : ""}. Live data updates during market hours (9:15 AM - 3:30 PM IST).</span>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card border border-card-border rounded-xl p-5">
          <div className="text-xs text-muted mb-1 font-medium">🔥 PDH Crossed</div>
          <div className="text-3xl font-bold text-profit">{pdhCount}</div>
          <div className="text-[10px] text-muted mt-1">Stocks above Previous Day High</div>
        </div>
        <div className="bg-card border border-card-border rounded-xl p-5">
          <div className="text-xs text-muted mb-1 font-medium">🚀 Combo Surge</div>
          <div className="text-3xl font-bold text-profit">{comboCount}</div>
          <div className="text-[10px] text-muted mt-1">PDH + Volume ≥ 1.5x avg</div>
        </div>
        <div className="bg-card border border-card-border rounded-xl p-5">
          <div className="text-xs text-muted mb-1 font-medium">🔻 PDL Crossed</div>
          <div className="text-3xl font-bold text-loss">{pdlCount}</div>
          <div className="text-[10px] text-muted mt-1">Stocks below Previous Day Low</div>
        </div>
        <div className="bg-card border border-card-border rounded-xl p-5">
          <div className="text-xs text-muted mb-1 font-medium">💀 Combo Sell</div>
          <div className="text-3xl font-bold text-loss">{comboSellCount}</div>
          <div className="text-[10px] text-muted mt-1">PDL + Volume ≥ 1.5x avg</div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        <button type="button" onClick={() => void load()} disabled={loading} className="workspace-button">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
        {data?.timestamp && (
          <span className="ml-auto">Updated {new Date(data.timestamp).toLocaleTimeString("en-IN")}</span>
        )}
      </div>

      {/* Bull Side Detail */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-card-border bg-profit/5">
            <h3 className="font-semibold text-profit text-sm">🟢 BULL Signals</h3>
          </div>
          <div className="p-4 space-y-3">
            <div>
              <div className="text-xs text-muted mb-2 font-medium">PDH Crossed ({pdhCount})</div>
              <div className="flex flex-wrap gap-1.5">
                {(data?.pdhCrossed || []).length > 0 ? (
                  data!.pdhCrossed.map((sym) => (
                    <a
                      key={sym}
                      href={decisionHref(sym)}
                      className="bg-profit/10 text-profit text-[10px] px-2 py-0.5 rounded font-mono font-semibold hover:underline"
                      title="Open decision cockpit"
                    >
                      {sym}
                      {data?.firstCrossTime?.[sym] && <span className="text-muted ml-1">{data.firstCrossTime[sym]}</span>}
                    </a>
                  ))
                ) : (
                  <span className="text-muted text-xs">No PDH crosses yet</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted mb-2 font-medium">Combo Surge ({comboCount})</div>
              <div className="flex flex-wrap gap-1.5">
                {(data?.comboSurge || []).length > 0 ? (
                  data!.comboSurge.map((sym) => (
                    <a key={sym} href={decisionHref(sym)} className="bg-profit/20 text-profit text-[10px] px-2 py-0.5 rounded font-mono font-bold border border-profit/30 hover:underline" title="Open decision cockpit">
                      🔥 {sym}
                    </a>
                  ))
                ) : (
                  <span className="text-muted text-xs">No combo surges yet</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bear Side Detail */}
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-card-border bg-loss/5">
            <h3 className="font-semibold text-loss text-sm">🔴 BEAR Signals</h3>
          </div>
          <div className="p-4 space-y-3">
            <div>
              <div className="text-xs text-muted mb-2 font-medium">PDL Crossed ({pdlCount})</div>
              <div className="flex flex-wrap gap-1.5">
                {(data?.pdlCrossed || []).length > 0 ? (
                  data!.pdlCrossed.map((sym) => (
                    <a
                      key={sym}
                      href={decisionHref(sym)}
                      className="bg-loss/10 text-loss text-[10px] px-2 py-0.5 rounded font-mono font-semibold hover:underline"
                      title="Open decision cockpit"
                    >
                      {sym}
                      {data?.firstPDLTime?.[sym] && <span className="text-muted ml-1">{data.firstPDLTime[sym]}</span>}
                    </a>
                  ))
                ) : (
                  <span className="text-muted text-xs">No PDL crosses yet</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted mb-2 font-medium">Combo Sell ({comboSellCount})</div>
              <div className="flex flex-wrap gap-1.5">
                {(data?.comboSell || []).length > 0 ? (
                  data!.comboSell.map((sym) => (
                    <a key={sym} href={decisionHref(sym)} className="bg-loss/20 text-loss text-[10px] px-2 py-0.5 rounded font-mono font-bold border border-loss/30 hover:underline" title="Open decision cockpit">
                      💀 {sym}
                    </a>
                  ))
                ) : (
                  <span className="text-muted text-xs">No combo sells yet</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Explanation */}
      {pdhCount === 0 && pdlCount === 0 && (
        <div className="bg-card border border-card-border rounded-xl p-6 text-center">
          <p className="text-muted text-sm">
            Live signals track stocks crossing their Previous Day High (PDH) or Previous Day Low (PDL) in real-time during market hours.
            <br />
            <strong>Combo Surge</strong> = PDH cross + volume ≥ 1.5x average (high conviction buy signal).
            <br />
            <strong>Combo Sell</strong> = PDL cross + volume ≥ 1.5x average (high conviction sell signal).
          </p>
        </div>
      )}
    </div>
  );
}
