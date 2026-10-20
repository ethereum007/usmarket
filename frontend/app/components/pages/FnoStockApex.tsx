"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, CandlestickChart, ListTree } from "lucide-react";
import { fetchAPI } from "../../lib/api";
import { cn, formatNumber, isMarketOpen, profitLossColor } from "../../lib/utils";
import { GaugeDial } from "../charts/GaugeDial";
import { OIClockView } from "../options/OIClockView";
import { StrikeScopeToggle } from "../options/StrikeScopeToggle";
import { getAtmStrike, getAtmWindow, type StrikeScope } from "../options/strikeScope";

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChainStrike {
  strike: number;
  call: { oi: number; oiChange: number; volume: number; ltp: number; iv: number | null } | null;
  put: { oi: number; oiChange: number; volume: number; ltp: number; iv: number | null } | null;
}

interface ChainResponse {
  success: boolean;
  symbol: string;
  spot: number;
  expiry: string;
  expiries: string[];
  lotSize: number;
  chain: ChainStrike[];
  analytics: {
    pcr: number;
    pcrSentiment: string;
    maxPainStrike: number;
    totalCallOI: number;
    totalPutOI: number;
  };
}

interface FnoStockApexProps {
  symbol: string;
  view: "chart" | "options";
  onBack: () => void;
  onViewChange: (view: "chart" | "options") => void;
  embedded?: boolean;
}

const INTERVALS = [
  { key: "3minute", label: "3m" },
  { key: "5minute", label: "5m" },
  { key: "15minute", label: "15m" },
];

export default function FnoStockApex({ symbol, view, onBack, onViewChange, embedded = false }: FnoStockApexProps) {
  const [interval, setInterval_] = useState("5minute");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [chainLoading, setChainLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(0);
  const chartRef = useRef<HTMLCanvasElement>(null);

  const loadCandles = useCallback(async () => {
    try {
      const response = await fetchAPI(`/api/quotes/intraday?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
      if (response.success) setCandles(response.data);
      setLastUpdated(Date.now());
    } catch {
      // ignore — keep prior data
    }
    setCandlesLoading(false);
  }, [symbol, interval]);

  useEffect(() => {
    setCandlesLoading(true);
    setCandles([]);
    void loadCandles();
    const timer = window.setInterval(loadCandles, 30000);
    return () => clearInterval(timer);
  }, [loadCandles]);

  const loadChain = useCallback(async () => {
    try {
      const response = await fetchAPI<ChainResponse>(`/api/fno/chain/${encodeURIComponent(symbol)}`);
      if (response.success) setChain(response);
      setLastUpdated(Date.now());
    } catch {
      // keep the last complete chain while the provider recovers
    }
    setChainLoading(false);
  }, [symbol]);

  useEffect(() => {
    setChainLoading(true);
    setChain(null);
    void loadChain();
    const timer = window.setInterval(loadChain, 90000);
    return () => clearInterval(timer);
  }, [loadChain]);

  // Draw candlestick chart (mirrors ApexContent's canvas approach)
  useEffect(() => {
    if (!chartRef.current || candles.length < 2) return;

    const canvas = chartRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    const styles = getComputedStyle(document.documentElement);
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const bgColor = styles.getPropertyValue("--chart-bg").trim() || "#111620";
    const gridColor = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.06)";
    const textColor = styles.getPropertyValue("--muted").trim() || "#8b95a5";
    const profitColor = "#00c853";
    const lossColor = "#ff1744";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    const chartH = H * 0.72;
    const volH = H * 0.18;
    const padding = { top: 10, bottom: 40, left: 5, right: 55 };

    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const priceRange = maxPrice - minPrice || 1;
    const maxVol = Math.max(...candles.map((c) => c.volume)) || 1;

    const candleWidth = Math.max(2, (W - padding.left - padding.right) / candles.length - 1);
    const gap = 1;

    function priceToY(p: number): number {
      return padding.top + (1 - (p - minPrice) / priceRange) * chartH;
    }

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    const priceLevels = 5;
    for (let i = 0; i <= priceLevels; i++) {
      const y = padding.top + (chartH / priceLevels) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(W - padding.right, y);
      ctx.stroke();

      const price = maxPrice - (priceRange / priceLevels) * i;
      ctx.fillStyle = textColor;
      ctx.font = "10px monospace";
      ctx.textAlign = "right";
      ctx.fillText(price.toFixed(1), W - 5, y + 3);
    }

    candles.forEach((c, i) => {
      const x = padding.left + i * (candleWidth + gap);
      const isGreen = c.close >= c.open;
      const color = isGreen ? profitColor : lossColor;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + candleWidth / 2, priceToY(c.high));
      ctx.lineTo(x + candleWidth / 2, priceToY(c.low));
      ctx.stroke();

      const bodyTop = priceToY(Math.max(c.open, c.close));
      const bodyBottom = priceToY(Math.min(c.open, c.close));
      const bodyHeight = Math.max(1, bodyBottom - bodyTop);

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, bodyTop, candleWidth, bodyHeight);
      ctx.globalAlpha = 1;

      const volY = chartH + padding.top + 15;
      const volBarH = (c.volume / maxVol) * volH;
      ctx.fillStyle = isGreen ? "rgba(0,200,83,0.3)" : "rgba(255,23,68,0.3)";
      ctx.fillRect(x, volY + volH - volBarH, candleWidth, volBarH);
    });

    ctx.fillStyle = textColor;
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    const labelInterval = Math.max(1, Math.floor(candles.length / 8));
    candles.forEach((c, i) => {
      if (i % labelInterval === 0) {
        const x = padding.left + i * (candleWidth + gap) + candleWidth / 2;
        const d = new Date(c.time);
        const label = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
        ctx.fillText(label, x, H - 5);
      }
    });

    if (candles.length > 0) {
      const lastPrice = candles[candles.length - 1].close;
      const y = priceToY(lastPrice);
      ctx.strokeStyle = "#448aff";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(W - padding.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#448aff";
      ctx.fillRect(W - padding.right, y - 8, padding.right, 16);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(lastPrice.toFixed(1), W - padding.right / 2, y + 3);
    }
  }, [candles]);

  const sentiment = useMemo(() => {
    const pcr = chain?.analytics.pcr ?? 1;
    if (candles.length < 2) return { score: 50, label: "NEUTRAL" };
    const lastCandle = candles[candles.length - 1];
    const firstCandle = candles[0];
    const priceMomentum = ((lastCandle.close - firstCandle.open) / firstCandle.open) * 100;

    let score = 50;
    score += priceMomentum * 8;
    score += (pcr - 1) * 15;
    score = Math.max(0, Math.min(100, score));
    const label =
      score > 75 ? "STRONG BUY" :
      score > 58 ? "BULLISH" :
      score < 25 ? "STRONG SELL" :
      score < 42 ? "BEARISH" :
      "NEUTRAL";
    return { score, label };
  }, [candles, chain]);

  const pcr = chain?.analytics.pcr ?? 0;
  const pcrDialPos = useMemo(() => Math.max(0, Math.min(100, (pcr - 0.5) * 100)), [pcr]);

  // Derive resistance/support arrays + strikeStep for OIClockView
  const oiClockAnalytics = useMemo(() => {
    if (!chain) return null;
    const calls = [...chain.chain]
      .filter((s) => s.call && s.call.oi > 0)
      .sort((a, b) => (b.call!.oi || 0) - (a.call!.oi || 0))
      .slice(0, 3)
      .map((s) => s.strike);
    const puts = [...chain.chain]
      .filter((s) => s.put && s.put.oi > 0)
      .sort((a, b) => (b.put!.oi || 0) - (a.put!.oi || 0))
      .slice(0, 3)
      .map((s) => s.strike);
    return {
      pcr: chain.analytics.pcr,
      pcrSentiment: chain.analytics.pcrSentiment,
      totalCallOI: chain.analytics.totalCallOI,
      totalPutOI: chain.analytics.totalPutOI,
      maxPainStrike: chain.analytics.maxPainStrike,
      resistance: calls,
      support: puts,
    };
  }, [chain]);

  const strikeStep = useMemo(() => {
    if (!chain || chain.chain.length < 2) return 50;
    const sorted = [...chain.chain].sort((a, b) => a.strike - b.strike);
    return sorted[1].strike - sorted[0].strike || 50;
  }, [chain]);

  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const dayChange = candles.length > 0 ? lastClose - candles[0].open : 0;
  const chartContext = useMemo(() => {
    if (candles.length < 2) return undefined;
    const first = candles[0];
    const last = candles[candles.length - 1];
    const recent = candles.slice(-8);
    const totalPv = candles.reduce((sum, candle) => sum + candle.close * candle.volume, 0);
    const totalVolume = candles.reduce((sum, candle) => sum + candle.volume, 0);
    const changePct = first.open ? ((last.close - first.open) / first.open) * 100 : 0;
    const recentHigh = Math.max(...recent.map((candle) => candle.high));
    const recentLow = Math.min(...recent.map((candle) => candle.low));
    const trend: "UP" | "DOWN" | "SIDEWAYS" =
      changePct > 0.35 && last.close >= recentHigh * 0.995
        ? "UP"
        : changePct < -0.35 && last.close <= recentLow * 1.005
          ? "DOWN"
          : "SIDEWAYS";
    return {
      timeframe: INTERVALS.find((item) => item.key === interval)?.label || interval,
      open: first.open,
      high: Math.max(...candles.map((candle) => candle.high)),
      low: Math.min(...candles.map((candle) => candle.low)),
      close: last.close,
      vwap: totalVolume > 0 ? totalPv / totalVolume : undefined,
      changePct,
      recentHigh,
      recentLow,
      trend,
    };
  }, [candles, interval]);

  return (
    <div className="space-y-4">
      {!embedded && <div className="rounded-xl bg-card p-4 shadow-sm">
        <button onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-accent"><ArrowLeft size={14} /> Back to F&amp;O radar</button>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div><div className="flex flex-wrap items-center gap-2"><h2 className="font-mono text-2xl font-black text-text-heading">{symbol}</h2><span className="rounded bg-profit-bg px-2 py-1 text-[11px] font-black text-profit">F&amp;O</span>{lastUpdated > 0 && <span className="flex items-center gap-1.5 text-xs text-muted"><span className={cn("h-2 w-2 rounded-full", isMarketOpen() ? "animate-pulse bg-profit" : "bg-warning")} />{isMarketOpen() ? "Live" : "Last session"}</span>}</div><p className="mt-1 text-sm text-muted">Price action, option-chain positioning, and OI context in one stock view.</p></div>
          <div className="flex flex-wrap gap-2"><Link href={`/pulse/intraday/${encodeURIComponent(symbol)}`} className="workspace-button">Intraday chart <ArrowUpRight size={14} /></Link><Link href={`/radar-trade?symbol=${encodeURIComponent(symbol)}`} className="workspace-button">Trade view <ArrowUpRight size={14} /></Link></div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-card-border/60 pt-3">
          <div className="inline-flex rounded-lg bg-surface-hover p-1"><button type="button" onClick={() => onViewChange("chart")} className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-bold", view === "chart" ? "bg-card text-accent shadow-sm" : "text-muted hover:text-text-heading")}><CandlestickChart size={14} /> Price chart</button><button type="button" onClick={() => onViewChange("options")} className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-bold", view === "options" ? "bg-card text-accent shadow-sm" : "text-muted hover:text-text-heading")}><ListTree size={14} /> Option chain &amp; OI</button></div>
          {view === "chart" && <div className="flex rounded-lg bg-surface-hover p-1">{INTERVALS.map((t) => <button key={t.key} onClick={() => setInterval_(t.key)} className={cn("rounded-md px-2.5 py-1.5 text-xs font-medium", interval === t.key ? "bg-card text-accent shadow-sm" : "text-muted hover:text-foreground")}>{t.label}</button>)}</div>}
        </div>
      </div>}

      {view === "chart" && candlesLoading && candles.length === 0 && (
        <div className="h-[500px] animate-pulse rounded-xl bg-card shadow-sm" />
      )}

      {view === "chart" && <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-4">
        {/* Candlestick chart */}
        <div className="rounded-xl bg-card p-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{symbol}</span>
              <span
                className={cn(
                  "text-xs font-bold px-2.5 py-0.5 rounded-full",
                  sentiment.score > 58 ? "bg-profit-bg text-profit" :
                  sentiment.score < 42 ? "bg-loss-bg text-loss" :
                  "bg-card-border/30 text-muted"
                )}
              >
                {sentiment.label}
              </span>
            </div>
            {candles.length > 0 && (
              <span className={cn("text-sm font-mono font-bold", profitLossColor(dayChange))}>
                {formatNumber(lastClose)}
              </span>
            )}
          </div>
          <canvas ref={chartRef} className="w-full" style={{ height: "300px" }} />
        </div>

        {/* Right column: gauges + OI summary */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-surface-hover/60 p-3">
              <GaugeDial
                value={sentiment.score}
                label="Sentiment"
                zones={[
                  { from: 0, to: 30, color: "var(--loss)" },
                  { from: 30, to: 45, color: "rgba(255,23,68,0.4)" },
                  { from: 45, to: 55, color: "var(--muted)" },
                  { from: 55, to: 70, color: "rgba(0,200,83,0.4)" },
                  { from: 70, to: 100, color: "var(--profit)" },
                ]}
                labels={["STRONG\nSELL", "SELL", "NEUTRAL", "BUY", "STRONG\nBUY"]}
              />
              <div className="flex justify-center mt-1">
                <span
                  className={cn(
                    "text-xs font-bold px-3 py-1 rounded-full",
                    sentiment.score > 58 ? "bg-profit-bg text-profit" :
                    sentiment.score < 42 ? "bg-loss-bg text-loss" :
                    "bg-card-border/30 text-muted"
                  )}
                >
                  {sentiment.label}
                </span>
              </div>
            </div>

            <div className="rounded-xl bg-surface-hover/60 p-3">
              <GaugeDial
                value={pcrDialPos}
                label={`PCR: ${pcr.toFixed(2)}`}
                zones={[
                  { from: 0, to: 20, color: "var(--loss)" },
                  { from: 20, to: 40, color: "rgba(255,23,68,0.4)" },
                  { from: 40, to: 60, color: "var(--accent)" },
                  { from: 60, to: 80, color: "rgba(0,200,83,0.4)" },
                  { from: 80, to: 100, color: "var(--profit)" },
                ]}
                labels={["STRONG\nSELL", "SELL", "NEUTRAL", "BUY", "STRONG\nBUY"]}
              />
              <div className="flex justify-center mt-1">
                <span
                  className={cn(
                    "text-xs font-bold px-3 py-1 rounded-full",
                    pcr > 1.2 ? "bg-profit-bg text-profit" :
                    pcr < 0.8 ? "bg-loss-bg text-loss" :
                    "bg-card-border/30 text-muted"
                  )}
                >
                  {pcr > 1.3 ? "BULLISH" : pcr > 1.1 ? "MILDLY BULLISH" :
                   pcr < 0.7 ? "BEARISH" : pcr < 0.9 ? "MILDLY BEARISH" : "NEUTRAL"}
                </span>
              </div>
            </div>
          </div>

        </div>
      </div>}

      {/* Quick meta strip — Spot, Expiry, Lot Size, totals */}
      {chain && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <MetaCell label="Spot" value={formatNumber(chain.spot)} />
          <MetaCell label="Expiry" value={chain.expiry} />
          <MetaCell label="Lot Size" value={String(chain.lotSize)} />
          <MetaCell label="Max Pain" value={formatNumber(chain.analytics.maxPainStrike, 0)} accent="warning" />
          <MetaCell label="Total Call OI" value={`${(chain.analytics.totalCallOI / 100000).toFixed(1)}L`} accent="loss" />
          <MetaCell label="Total Put OI" value={`${(chain.analytics.totalPutOI / 100000).toFixed(1)}L`} accent="profit" />
        </div>
      )}

      {/* Full OI Clock — strike-by-strike bars + Net Position + Distribution + Key OI Levels */}
      {view === "options" && chain && oiClockAnalytics && <div className="space-y-4"><OIClockView chain={chain.chain as any} spot={chain.spot} strikeStep={strikeStep} chartContext={chartContext} analytics={oiClockAnalytics} /><StockOptionChainTable chain={chain} /></div>}
      {view === "options" && chainLoading && !chain && <div className="h-64 animate-pulse rounded-xl bg-card shadow-sm" aria-label="Loading option chain" />}
      {view === "options" && !chainLoading && !chain && <div className="rounded-xl bg-card px-6 py-14 text-center shadow-sm"><h3 className="font-bold text-text-heading">Option chain unavailable</h3><p className="mt-2 text-sm text-muted">The derivatives feed did not return an active contract for {symbol}.</p></div>}
    </div>
  );
}

function StockOptionChainTable({ chain }: { chain: ChainResponse }) {
  const [scope, setScope] = useState<StrikeScope>("near");
  const sorted = useMemo(() => [...chain.chain].sort((a, b) => a.strike - b.strike), [chain.chain]);
  if (sorted.length === 0) {
    return <section className="rounded-xl bg-card px-6 py-10 text-center shadow-sm"><h3 className="font-bold text-text-heading">No active strikes</h3><p className="mt-2 text-sm text-muted">The feed returned the contract, but no option strikes are available right now.</p></section>;
  }
  const visible = scope === "all" ? sorted : getAtmWindow(sorted, chain.spot, 5);
  const atmStrike = getAtmStrike(sorted, chain.spot);
  return <section className="overflow-hidden rounded-xl bg-card shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border/60 px-4 py-3"><div><h3 className="text-sm font-black text-text-heading">Option chain</h3><p className="mt-0.5 text-xs text-muted">{visible.length} strikes · expiry {chain.expiry}</p></div><div className="flex flex-wrap items-center gap-2"><span className="rounded bg-accent-bg px-2 py-1 font-mono text-xs font-bold text-accent">Spot {formatNumber(chain.spot)}</span><StrikeScopeToggle value={scope} onChange={setScope} total={sorted.length} compact /></div></div><div className={cn("overflow-x-auto", scope === "all" && "max-h-[620px] overflow-y-auto")}><table className="w-full min-w-[820px] text-right text-xs"><thead className="sticky top-0 z-10 bg-surface-hover text-[10px] uppercase tracking-wide text-muted"><tr><th className="px-3 py-2.5">Call OI</th><th className="px-3 py-2.5">Call ΔOI</th><th className="px-3 py-2.5">Call LTP</th><th className="px-3 py-2.5 text-center">Strike</th><th className="px-3 py-2.5">Put LTP</th><th className="px-3 py-2.5">Put ΔOI</th><th className="px-3 py-2.5">Put OI</th></tr></thead><tbody className="divide-y divide-card-border/50">{visible.map((row) => <tr key={row.strike} className={row.strike === atmStrike ? "bg-accent-bg/40" : "hover:bg-hover-bg"}><OptionValue value={row.call?.oi} /><OptionValue value={row.call?.oiChange} signed /><OptionPrice value={row.call?.ltp} /><td className="px-3 py-2.5 text-center"><span className={cn("rounded px-2 py-1 font-mono font-black", row.strike === atmStrike ? "bg-accent text-white" : "bg-surface-hover text-text-heading")}>{formatNumber(row.strike, 0)}</span></td><OptionPrice value={row.put?.ltp} /><OptionValue value={row.put?.oiChange} signed /><OptionValue value={row.put?.oi} /></tr>)}</tbody></table></div></section>;
}

function OptionValue({ value, signed = false }: { value?: number | null; signed?: boolean }) {
  if (value == null) return <td className="px-3 py-2.5 text-muted">-</td>;
  return <td className={cn("px-3 py-2.5 font-mono", signed && (value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-muted"))}>{signed && value > 0 ? "+" : ""}{formatCompact(value)}</td>;
}

function OptionPrice({ value }: { value?: number | null }) {
  return <td className="px-3 py-2.5 font-mono text-foreground">{value == null ? "-" : formatNumber(value)}</td>;
}

function formatCompact(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 10_000_000) return `${(value / 10_000_000).toFixed(1)}Cr`;
  if (absolute >= 100_000) return `${(value / 100_000).toFixed(1)}L`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-IN");
}

function MetaCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "profit" | "loss" | "warning";
}) {
  const valueColor =
    accent === "profit" ? "text-profit" :
    accent === "loss" ? "text-loss" :
    accent === "warning" ? "text-warning" :
    "text-foreground";
  return (
    <div className="rounded-lg bg-card p-3 shadow-sm">
      <div className="text-[10px] text-muted mb-1 uppercase tracking-wider">{label}</div>
      <div className={cn("text-sm font-mono font-bold", valueColor)}>{value}</div>
    </div>
  );
}
