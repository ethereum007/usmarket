"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchAPI, postAPI } from "../../lib/api";
import { SectorHeatmap } from "../heatmap/SectorHeatmap";
import { cn } from "../../lib/utils";
import {
  type UniverseKey,
  UNIVERSE_META,
  getUniverse,
  getSector,
} from "../../lib/stock-universe";

interface StockData {
  symbol: string;
  sector: string;
  last: number;
  changePercent: number;
  volume: number;
}

export function DashboardHeatmap() {
  const [universe, setUniverse] = useState<UniverseKey>("nifty50");
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [loading, setLoading] = useState(true);
  const [sizeBy, setSizeBy] = useState<"volume" | "equal">("equal");

  const loadQuotes = useCallback(async () => {
    const symbols = getUniverse(universe);
    try {
      let data: Record<string, any>;

      if (symbols.length <= 50) {
        const res = await fetchAPI(`/api/quotes?symbols=${symbols.join(",")}`);
        data = res.success ? res.data : {};
      } else {
        const res = await postAPI("/api/quotes/batch", { symbols });
        data = res.success ? res.data : {};
      }

      const parsed: StockData[] = Object.entries(data).map(
        ([key, q]: [string, any]) => {
          const sym = key.replace("NSE:", "");
          return {
            symbol: sym,
            sector: getSector(sym),
            last: q.last_price,
            changePercent: q.ohlc?.close
              ? ((q.last_price - q.ohlc.close) / q.ohlc.close) * 100
              : 0,
            volume: q.volume || 0,
          };
        }
      );
      setStocks(parsed);
    } catch {}
    setLoading(false);
  }, [universe]);

  useEffect(() => {
    setLoading(true);
    setStocks([]);
    loadQuotes();
    const interval = setInterval(loadQuotes, universe === "nifty50" ? 15000 : 45000);
    return () => clearInterval(interval);
  }, [loadQuotes, universe]);

  return (
    <section className="bg-card border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          {UNIVERSE_META[universe].label} Heatmap
        </h2>
        <div className="flex items-center gap-2">
          {/* Universe selector */}
          <div className="flex gap-0.5 bg-background border border-card-border rounded p-0.5">
            {(Object.keys(UNIVERSE_META) as UniverseKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setUniverse(key)}
                className={cn(
                  "px-2 py-1 rounded text-xs font-medium transition-colors",
                  universe === key
                    ? "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {UNIVERSE_META[key].shortLabel}
              </button>
            ))}
          </div>
          {/* Size toggle */}
          <div className="flex gap-0.5 bg-background border border-card-border rounded p-0.5">
            {(["equal", "volume"] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setSizeBy(opt)}
                className={cn(
                  "px-2 py-1 rounded text-xs",
                  sizeBy === opt ? "bg-accent text-white" : "text-muted hover:text-foreground"
                )}
              >
                {opt === "equal" ? "Equal" : "By Volume"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Stats line */}
      {stocks.length > 0 && (
        <div className="flex gap-3 mb-2 text-xs text-muted">
          <span>
            <span className="text-profit font-medium">
              {stocks.filter((s) => s.changePercent > 0).length}
            </span>{" "}
            advancing
          </span>
          <span>
            <span className="text-loss font-medium">
              {stocks.filter((s) => s.changePercent < 0).length}
            </span>{" "}
            declining
          </span>
          <span>{stocks.length} stocks loaded</span>
        </div>
      )}

      {loading ? (
        <div className="h-[400px] bg-background border border-card-border rounded-lg animate-pulse flex items-center justify-center">
          <span className="text-muted text-sm">
            Loading {UNIVERSE_META[universe].label} data...
          </span>
        </div>
      ) : (
        <div className="max-h-[450px] overflow-y-auto rounded-lg">
          <div className={cn(
            universe === "nifty50" ? "h-[400px]" : "h-[450px]"
          )}>
            <SectorHeatmap
              stocks={stocks}
              sizeBy={sizeBy}
              onStockClick={(sym) => window.open(`/stocks?symbol=${sym}`, "_self")}
            />
          </div>
        </div>
      )}
    </section>
  );
}
