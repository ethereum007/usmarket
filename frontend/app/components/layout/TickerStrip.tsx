"use client";

import { useEffect, useState } from "react";
import { fetchAPI } from "../../lib/api";

interface TickerItem {
  label: string;
  value: string;
  chg: number;
  isIndex?: boolean;
}

export function TickerStrip() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<TickerItem[]>([]);

  useEffect(() => {
    async function load() {
      const tickerItems: TickerItem[] = [];

      // Fetch indices
      try {
        const res = await fetchAPI<any>("/api/quotes/indices");
        if (res.indices) {
          for (const idx of res.indices) {
            tickerItems.push({
              label: idx.key || idx.name || idx.symbol,
              value: idx.ltp?.toLocaleString("en-IN") || idx.last?.toLocaleString("en-IN") || "—",
              chg: +(idx.chg ?? idx.chgPct ?? idx.changePercent ?? idx.changePct ?? 0),
              isIndex: true,
            });
          }
        } else if (res.data && Array.isArray(res.data)) {
          for (const idx of res.data) {
            tickerItems.push({
              label: idx.name || idx.symbol?.replace("NSE:", ""),
              value: idx.last?.toLocaleString("en-IN") || "—",
              chg: +(idx.changePercent ?? 0),
              isIndex: true,
            });
          }
        }
      } catch {}

      // Fetch top movers
      try {
        const res = await fetchAPI<any>("/api/top-movers");
        if (res.gainers) {
          for (const s of res.gainers.slice(0, 5)) {
            tickerItems.push({
              label: s.symbol,
              value: `Rs ${s.ltp?.toLocaleString("en-IN") || s.last?.toLocaleString("en-IN") || "—"}`,
              chg: +(s.chg ?? s.chgPct ?? s.changePct ?? s.changePercent ?? 0),
            });
          }
        }
        if (res.losers) {
          for (const s of res.losers.slice(0, 5)) {
            tickerItems.push({
              label: s.symbol,
              value: `Rs ${s.ltp?.toLocaleString("en-IN") || s.last?.toLocaleString("en-IN") || "—"}`,
              chg: +(s.chg ?? s.chgPct ?? s.changePct ?? s.changePercent ?? 0),
            });
          }
        }
      } catch {}

      if (tickerItems.length > 0) setItems(tickerItems);
      setLoading(false);
    }

    load();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => clearInterval(interval);
  }, []);

  if (!items.length) return <div className="workspace-tape px-5 text-xs text-muted" role="status">{loading ? "Loading market quotes…" : "Market quotes are currently unavailable."}</div>;

  return (
    <div className="workspace-tape" aria-label="Market quotes">
      <span className="tape-label">MARKET TAPE</span>
      <div className="tape-items" tabIndex={0} aria-label="Scroll market quotes horizontally">
        {items.map((item, index) => (
          <div key={`${item.label}-${index}`} className="tape-item">
            <span className="tape-label-text">{item.label}</span>
            <strong className="font-mono">{item.value}</strong>
            <span className={item.chg > 0 ? "text-profit" : item.chg < 0 ? "text-loss" : "text-muted"}>
              {item.chg > 0 ? "+" : ""}{item.chg.toFixed(2)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
