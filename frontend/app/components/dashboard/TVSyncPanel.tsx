"use client";

import { useEffect, useState } from "react";
import { fetchAPI } from "../../lib/api";
import { formatNumber, cn } from "../../lib/utils";

interface TVState {
  connected: boolean;
  symbol?: string;
  resolution?: string;
  chartType?: number;
  targetTitle?: string;
  error?: string;
}

interface TVLevel {
  name: string;
  prices?: number[];
  labels?: { text: string; price: number }[];
}

export function TVSyncPanel() {
  const [tvState, setTvState] = useState<TVState | null>(null);
  const [levels, setLevels] = useState<TVLevel[]>([]);
  const [labels, setLabels] = useState<TVLevel[]>([]);
  const [loading, setLoading] = useState(false);

  async function checkTV() {
    setLoading(true);
    try {
      const res = await fetchAPI("/api/tv/health");
      setTvState(res);

      if (res.connected) {
        const levelsRes = await fetchAPI("/api/tv/levels");
        if (levelsRes.success) {
          setLevels(levelsRes.lines || []);
          setLabels(levelsRes.labels || []);
        }
      }
    } catch {
      setTvState({ connected: false, error: "Gateway not reachable" });
    }
    setLoading(false);
  }

  useEffect(() => {
    checkTV();
    const interval = setInterval(checkTV, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  async function syncSymbol(symbol: string) {
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || ""}/api/tv/symbol`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol }),
        }
      );
      setTimeout(checkTV, 1000);
    } catch {}
  }

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">TradingView Sync</h3>
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              tvState?.connected ? "bg-profit animate-pulse" : "bg-loss"
            )}
          />
        </div>
        <button
          onClick={checkTV}
          disabled={loading}
          className="text-xs text-accent hover:text-accent/80 disabled:opacity-50"
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>

      {!tvState?.connected ? (
        <div className="text-xs text-muted space-y-1">
          <p>TradingView Desktop not detected.</p>
          <p>Launch with <code className="text-accent">--remote-debugging-port=9222</code></p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Current Chart */}
          <div className="flex items-center gap-3 text-sm">
            <span className="font-mono font-bold text-accent">{tvState.symbol}</span>
            <span className="text-muted">{tvState.resolution}</span>
          </div>

          {/* Pine Indicator Levels */}
          {levels.length > 0 && (
            <div>
              <div className="text-xs text-muted mb-1">Indicator Levels</div>
              {levels.map((study) => (
                <div key={study.name} className="mb-2">
                  <div className="text-xs text-muted/70 mb-0.5">{study.name}</div>
                  <div className="flex flex-wrap gap-1">
                    {study.prices?.slice(0, 10).map((price) => (
                      <span
                        key={price}
                        className="text-xs font-mono px-1.5 py-0.5 rounded bg-accent-bg text-accent"
                      >
                        {formatNumber(price)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pine Labels */}
          {labels.length > 0 && (
            <div>
              <div className="text-xs text-muted mb-1">Indicator Labels</div>
              {labels.map((study) => (
                <div key={study.name} className="space-y-0.5">
                  {study.labels?.slice(0, 8).map((lbl, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-muted truncate max-w-[120px]">{lbl.text}</span>
                      <span className="font-mono">{formatNumber(lbl.price)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {levels.length === 0 && labels.length === 0 && (
            <div className="text-xs text-muted">
              No Pine indicator levels detected on chart.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
