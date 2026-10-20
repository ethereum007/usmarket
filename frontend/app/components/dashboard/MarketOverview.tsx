"use client";

import { useEffect, useState } from "react";
import { fetchAPI } from "../../lib/api";
import { formatNumber, profitLossColor } from "../../lib/utils";

interface IndexData {
  name: string;
  last: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  monthReturn?: number;
}

interface HotColdData {
  name: string;
  symbol: string;
  last: number;
  monthReturn: number;
  changePct: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

// ISSUE 2: Human-readable name mapping for index keys
const INDEX_NAME_MAP: Record<string, string> = {
  NIFTY50: "NIFTY 50",
  BANKNIFTY: "BANK NIFTY",
  NIFTYBANK: "NIFTY BANK",
  SENSEX: "SENSEX",
  VIX: "INDIA VIX",
  MIDCAP: "NIFTY MIDCAP",
  SMALLCAP: "NIFTY SMALLCAP",
  NIFTYMIDCAP: "NIFTY MIDCAP",
  NIFTYSMALLCAP: "NIFTY SMALLCAP",
  NIFTY_MIDCAP: "NIFTY MIDCAP",
  NIFTY_SMALLCAP: "NIFTY SMALLCAP",
  NIFTY_BANK: "NIFTY BANK",
  BANK_NIFTY: "BANK NIFTY",
  INDIA_VIX: "INDIA VIX",
  INDIAVIX: "INDIA VIX",
};

function getDisplayName(rawName: string): string {
  // Try exact match first
  const upper = rawName.toUpperCase().replace(/[\s-]/g, "");
  if (INDEX_NAME_MAP[upper]) return INDEX_NAME_MAP[upper];
  // Try the raw key with spaces/underscores stripped
  const stripped = rawName.replace(/[_\s-]/g, "").toUpperCase();
  if (INDEX_NAME_MAP[stripped]) return INDEX_NAME_MAP[stripped];
  // Fallback: return original
  return rawName;
}

function IndexCard({ idx, badge }: { idx: IndexData; badge?: { emoji: string; text: string; type: "hot" | "cold" } }) {
  const isUp = idx.changePct > 0;
  const isDown = idx.changePct < 0;
  const barPct = (idx.high - idx.low) > 0 ? Math.min(100, Math.max(0, ((idx.last - idx.low) / (idx.high - idx.low)) * 100)) : 50;

  return (
    <div className="bg-card border border-card-border rounded-xl p-4 transition-colors">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted">{getDisplayName(idx.name)}</span>
        <div className="flex items-center gap-1">
          {badge && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badge.type === "hot" ? "bg-profit/10 text-profit" : "bg-loss/10 text-loss"}`}>
              {badge.emoji} {badge.text}
            </span>
          )}
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isUp ? "bg-profit/10 text-profit" : isDown ? "bg-loss/10 text-loss" : "bg-card text-muted"}`}>
            {isUp ? "▲" : isDown ? "▼" : "—"} {Math.abs(idx.changePct).toFixed(2)}%
          </span>
        </div>
      </div>
      <div className="text-xl font-bold text-foreground mb-1">
        {formatNumber(idx.last, idx.last > 50000 ? 0 : 2)}
      </div>
      <div className="flex items-center gap-3 mb-2">
        <div className={`text-xs ${profitLossColor(idx.change)}`}>
          1D: {idx.change >= 0 ? "+" : ""}{formatNumber(idx.change)} ({idx.changePct >= 0 ? "+" : ""}{idx.changePct.toFixed(2)}%)
        </div>
        {idx.monthReturn != null && idx.monthReturn !== 0 && (
          <div className={`text-xs ${profitLossColor(idx.monthReturn)}`}>
            1M: {idx.monthReturn >= 0 ? "+" : ""}{idx.monthReturn.toFixed(2)}%
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 text-[10px] text-muted mb-2">
        <div>Open <span className="text-foreground float-right">{formatNumber(idx.open, 0)}</span></div>
        <div>Prev Close <span className="text-foreground float-right">{formatNumber(idx.close, 0)}</span></div>
        <div>High <span className="text-profit float-right">{formatNumber(idx.high, 0)}</span></div>
        <div>Low <span className="text-loss float-right">{formatNumber(idx.low, 0)}</span></div>
      </div>
      <div className="h-1 bg-card-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${isUp ? "bg-profit" : isDown ? "bg-loss" : "bg-accent"}`} style={{ width: `${barPct}%` }} />
      </div>
    </div>
  );
}

export function MarketOverview() {
  const [indices, setIndices] = useState<IndexData[]>([]);
  const [hotData, setHotData] = useState<HotColdData | null>(null);
  const [coldData, setColdData] = useState<HotColdData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetchAPI<any>("/api/quotes/indices");
        const raw = res.data || res.indices || [];
        if (raw.length > 0) {
          const mapped: IndexData[] = raw.map((idx: any) => ({
            name: idx.name || idx.key || "",
            last: idx.last ?? idx.ltp ?? 0,
            change: idx.change ?? idx.chgAbs ?? 0,
            changePct: idx.changePercent ?? idx.chg ?? idx.chgPct ?? 0,
            open: idx.open ?? 0,
            high: idx.high ?? 0,
            low: idx.low ?? 0,
            close: idx.close ?? idx.prev ?? 0,
            monthReturn: idx.monthReturn ?? idx.month_return ?? 0,
          }));
          setIndices(mapped);
        }
      } catch {}
      setLoading(false);
    }
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, []);

  // Fetch hot/cold from new dedicated endpoint
  useEffect(() => {
    async function loadHotCold() {
      try {
        const res = await fetchAPI<any>("/api/hot-cold-indices");
        if (res.hot) {
          setHotData({
            name: res.hot.name || "",
            symbol: res.hot.symbol || "",
            last: res.hot.last ?? 0,
            monthReturn: res.hot.monthReturn ?? 0,
            changePct: res.hot.changePct ?? 0,
            open: res.hot.open ?? 0,
            high: res.hot.high ?? 0,
            low: res.hot.low ?? 0,
            close: res.hot.close ?? 0,
          });
        }
        if (res.cold) {
          setColdData({
            name: res.cold.name || "",
            symbol: res.cold.symbol || "",
            last: res.cold.last ?? 0,
            monthReturn: res.cold.monthReturn ?? 0,
            changePct: res.cold.changePct ?? 0,
            open: res.cold.open ?? 0,
            high: res.cold.high ?? 0,
            low: res.cold.low ?? 0,
            close: res.cold.close ?? 0,
          });
        }
      } catch {}
    }
    loadHotCold();
    const interval = setInterval(loadHotCold, 600000);
    return () => clearInterval(interval);
  }, []);

  // Convert HotColdData to IndexData for unified card rendering
  function hotColdToIndex(data: HotColdData): IndexData {
    return {
      name: data.name,
      last: data.last,
      change: data.last * (data.changePct / 100),
      changePct: data.changePct,
      open: data.open ?? 0,
      high: data.high ?? 0,
      low: data.low ?? 0,
      close: data.close ?? 0,
    };
  }

  // Row 1: NIFTY, SENSEX, BANKNIFTY, VIX
  // Row 2: MIDCAP, SMALLCAP, Hot, Cold
  const row1 = indices.slice(0, 4);
  const row2 = indices.slice(4);

  if (loading && indices.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold mb-4">Market Overview</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 bg-card border border-card-border rounded-xl animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Market Overview</h2>

      {/* Row 1: NIFTY, SENSEX, BANKNIFTY, VIX */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {row1.map((idx) => (
          <IndexCard key={idx.name} idx={idx} />
        ))}
      </div>

      {/* Row 2: MIDCAP, SMALLCAP, Hot Index, Cold Index */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {row2.map((idx) => (
          <IndexCard key={idx.name} idx={idx} />
        ))}
        {hotData && (
          <IndexCard
            idx={hotColdToIndex(hotData)}
            badge={{ emoji: "\uD83D\uDD25", text: `${hotData.monthReturn >= 0 ? "+" : ""}${hotData.monthReturn.toFixed(1)}% 1M`, type: "hot" }}
          />
        )}
        {coldData && (
          <IndexCard
            idx={hotColdToIndex(coldData)}
            badge={{ emoji: "\u2744\uFE0F", text: `${coldData.monthReturn >= 0 ? "+" : ""}${coldData.monthReturn.toFixed(1)}% 1M`, type: "cold" }}
          />
        )}
      </div>
    </section>
  );
}
