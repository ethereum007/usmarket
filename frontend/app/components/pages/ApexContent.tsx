"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { fetchAPI } from "../../lib/api";
import { formatNumber, cn, profitLossColor, isMarketOpen } from "../../lib/utils";
import { NIFTY50, getSector } from "../../lib/stock-universe";
import { SECTOR_INDICES } from "../../lib/sector-indices";
import { GaugeDial } from "../charts/GaugeDial";

const INDICES = [
  { key: "nifty", label: "Nifty 50", quoteSymbol: "NIFTY 50", token: 256265, stocks: NIFTY50 },
  { key: "banknifty", label: "Bank Nifty", quoteSymbol: "NIFTY BANK", token: 260105,
    stocks: SECTOR_INDICES.find((s) => s.name === "Nifty Bank")?.constituents || [] },
  { key: "finnifty", label: "Fin Nifty", quoteSymbol: "NIFTY FIN SERVICE", token: 257801,
    stocks: SECTOR_INDICES.find((s) => s.name === "Nifty Finance")?.constituents || [] },
  { key: "sensex", label: "Sensex", quoteSymbol: "SENSEX", token: 265, stocks: NIFTY50 },
];

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface StockFlow {
  symbol: string;
  changePct: number;
  volume: number;
  sector: string;
}

export default function ApexContent() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [interval, setInterval_] = useState("5minute");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [pcr, setPCR] = useState(0);
  const [pcrSentiment, setPCRSentiment] = useState("NEUTRAL");
  const [moneyFlux, setMoneyFlux] = useState<StockFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(0);
  const chartRef = useRef<HTMLCanvasElement>(null);

  const idx = INDICES[selectedIndex];

  const loadData = useCallback(async () => {
    try {
      const candleRes = await fetchAPI(
        `/api/quotes/intraday?symbol=${encodeURIComponent(idx.quoteSymbol)}&interval=${interval}`
      );
      if (candleRes.success) setCandles(candleRes.data);

      try {
        const oiRes = await fetchAPI(`/api/options/${idx.key}`);
        if (oiRes.success) {
          setPCR(oiRes.analytics?.pcr || 0);
          setPCRSentiment(oiRes.analytics?.pcrSentiment || "NEUTRAL");
        }
      } catch {}

      try {
        const stockSymbols = idx.stocks;
        const stockRes = await fetchAPI(`/api/quotes?symbols=${stockSymbols.join(",")}`);
        if (stockRes.success) {
          const flows: StockFlow[] = Object.entries(stockRes.data).map(([key, q]: [string, any]) => {
            const sym = key.replace("NSE:", "");
            const prev = q.ohlc?.close || q.last_price;
            return {
              symbol: sym,
              changePct: prev > 0 ? ((q.last_price - prev) / prev) * 100 : 0,
              volume: q.volume || 0,
              sector: getSector(sym),
            };
          });
          setMoneyFlux(flows);
        }
      } catch {}

      setLastUpdated(Date.now());
    } catch {}
    setLoading(false);
  }, [idx, interval]);

  useEffect(() => {
    setLoading(true);
    loadData();
    const timer = window.setInterval(loadData, 30000);
    return () => clearInterval(timer);
  }, [loadData]);

  // Draw candlestick chart on canvas
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
      ctx.fillText(price.toFixed(0), W - 5, y + 3);
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
    if (candles.length < 2) return { score: 50, label: "NEUTRAL" };
    const lastCandle = candles[candles.length - 1];
    const firstCandle = candles[0];
    const priceMomentum = ((lastCandle.close - firstCandle.open) / firstCandle.open) * 100;

    let score = 50;
    score += priceMomentum * 8;
    score += (pcr - 1) * 15;
    score = Math.max(0, Math.min(100, score));
    const label = score > 75 ? "STRONG BUY" : score > 58 ? "BULLISH" : score < 25 ? "STRONG SELL" : score < 42 ? "BEARISH" : "NEUTRAL";
    return { score, label };
  }, [candles, pcr]);

  const pcrDialPos = useMemo(() => {
    return Math.max(0, Math.min(100, (pcr - 0.5) * 100));
  }, [pcr]);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {lastUpdated > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span className={cn("w-2 h-2 rounded-full", isMarketOpen() ? "bg-profit animate-pulse" : "bg-yellow-500")} />
              {isMarketOpen() ? "Live" : "Last Session"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {INDICES.map((idx_, i) => (
              <button key={idx_.key} onClick={() => setSelectedIndex(i)}
                className={cn("px-3 py-1.5 rounded text-xs font-medium transition-colors",
                  selectedIndex === i ? "bg-accent text-white" : "text-muted hover:text-foreground")}>
                {idx_.label}
              </button>
            ))}
          </div>
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {[
              { key: "3minute", label: "3m" },
              { key: "5minute", label: "5m" },
              { key: "15minute", label: "15m" },
            ].map((t) => (
              <button key={t.key} onClick={() => setInterval_(t.key)}
                className={cn("px-2 py-1.5 rounded text-xs font-medium transition-colors",
                  interval === t.key ? "bg-accent text-white" : "text-muted hover:text-foreground")}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && !candles.length && (
        <div className="h-[500px] bg-card border border-card-border rounded-xl animate-pulse" />
      )}

      {/* Main layout */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-4">
        <div className="bg-card border border-card-border rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{idx.label}</span>
              {sentiment && (
                <span className={cn("text-xs font-bold px-2.5 py-0.5 rounded-full",
                  sentiment.score > 58 ? "bg-profit-bg text-profit" :
                  sentiment.score < 42 ? "bg-loss-bg text-loss" :
                  "bg-card-border/30 text-muted"
                )}>
                  {sentiment.label}
                </span>
              )}
            </div>
            {candles.length > 0 && (
              <span className={cn("text-sm font-mono font-bold",
                profitLossColor(candles[candles.length - 1].close - candles[0].open))}>
                {formatNumber(candles[candles.length - 1].close)}
              </span>
            )}
          </div>
          <canvas ref={chartRef} className="w-full" style={{ height: "300px" }} />
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-card border border-card-border rounded-xl p-3">
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
                <span className={cn("text-xs font-bold px-3 py-1 rounded-full",
                  sentiment.score > 58 ? "bg-profit-bg text-profit" :
                  sentiment.score < 42 ? "bg-loss-bg text-loss" :
                  "bg-card-border/30 text-muted"
                )}>
                  {sentiment.label}
                </span>
              </div>
            </div>

            <div className="bg-card border border-card-border rounded-xl p-3">
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
                <span className={cn("text-xs font-bold px-3 py-1 rounded-full",
                  pcr > 1.2 ? "bg-profit-bg text-profit" :
                  pcr < 0.8 ? "bg-loss-bg text-loss" :
                  "bg-card-border/30 text-muted"
                )}>
                  {pcr > 1.3 ? "BULLISH" : pcr > 1.1 ? "MILDLY BULLISH" :
                   pcr < 0.7 ? "BEARISH" : pcr < 0.9 ? "MILDLY BEARISH" : "NEUTRAL"}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-card border border-card-border rounded-xl p-3">
            <h3 className="text-sm font-semibold mb-2">Money Flux</h3>
            <div className="grid grid-cols-5 gap-1" style={{ minHeight: "300px" }}>
              {moneyFlux
                .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
                .map((s) => {
                  const intensity = Math.min(1, Math.abs(s.changePct) / 3);
                  const bg = s.changePct > 0
                    ? `rgba(0,200,83,${0.15 + intensity * 0.55})`
                    : s.changePct < 0
                    ? `rgba(255,23,68,${0.15 + intensity * 0.55})`
                    : `rgba(128,128,128,0.1)`;

                  return (
                    <div
                      key={s.symbol}
                      className="rounded-md flex flex-col items-center justify-center p-1 cursor-pointer hover:opacity-80 transition-opacity overflow-hidden"
                      style={{ backgroundColor: bg, minHeight: "48px" }}
                      onClick={() => window.open(`/stocks?symbol=${s.symbol}`, "_self")}
                      title={`${s.symbol}: ${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(2)}%`}
                    >
                      <span className="text-[11px] font-semibold text-foreground text-center leading-tight truncate w-full px-0.5">
                        {s.symbol}
                      </span>
                      <span className={cn("text-[10px] font-mono font-medium",
                        s.changePct > 0 ? "text-profit" : s.changePct < 0 ? "text-loss" : "text-muted")}>
                        {s.changePct > 0 ? "+" : ""}{s.changePct.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
