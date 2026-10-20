"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Clock3, RefreshCw } from "lucide-react";
import { CandlestickSeries, ColorType, createChart, type IChartApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { fetchAPI } from "../../lib/api";
import { loadFnoSymbols } from "../../lib/fno";
import { cn } from "../../lib/utils";

type ChartCandle = { time: string; open: number; high: number; low: number; close: number; volume: number; isForming: boolean };
type ChartSignal = { type: "FIVE_MIN_BREAKOUT" | "FIFTEEN_MIN_BREAKOUT" | "PREVIOUS_DAY_HIGH_BREAK" | "FIVE_MIN_BREAKDOWN" | "FIFTEEN_MIN_BREAKDOWN" | "PREVIOUS_DAY_LOW_BREAK"; timeframeMinutes: number; signalTime: string; triggerPrice: number; breakoutLevel?: number | null; bestReturnPct?: number | null; highReturnPct?: number | null; closeReturnPct?: number | null };
type ChartResponse = { success: boolean; symbol: string; direction: "LONG" | "SHORT"; sessionDate: string; timeframeMinutes: 5 | 15; marketHours: boolean; previousDayHigh?: number | null; previousDayLow?: number | null; formingBreakout: boolean; formingBreakdown: boolean; updatedAt: string; candles: ChartCandle[]; signals: ChartSignal[]; method: { evaluationCadenceSeconds: number; sourceResolutionMinutes: number; confirmation: string } };

export default function IntradayChartContent({ symbol }: { symbol: string }) {
  const [timeframe, setTimeframe] = useState<5 | 15>(5);
  const [data, setData] = useState<ChartResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFno, setIsFno] = useState(false);
  const marketOpen = useRef(true);
  useEffect(() => { marketOpen.current = data?.marketHours ?? true; }, [data?.marketHours]);
  const key = `alpha-radar:intraday-chart:${symbol}:${timeframe}`;

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const result = await fetchAPI<ChartResponse>(`/api/intraday/breakouts/${encodeURIComponent(symbol)}?timeframe=${timeframe}`);
      setData(result); window.sessionStorage.setItem(key, JSON.stringify(result)); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : "The chart is unavailable."); }
    finally { setLoading(false); }
  }, [key, symbol, timeframe]);

  useEffect(() => {
    const cached = window.sessionStorage.getItem(key);
    if (cached) { try { setData(JSON.parse(cached)); } catch {}; setLoading(false); }
    else setData(null);
    void load(Boolean(cached));
    const poll = window.setInterval(() => { if (document.visibilityState === "visible" && marketOpen.current) void load(true); }, 30_000);
    const resume = () => { if (document.visibilityState === "visible" && marketOpen.current) void load(true); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("focus", resume);
    return () => { window.clearInterval(poll); document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); };
  }, [key, load]);

  useEffect(() => {
    let cancelled = false;
    loadFnoSymbols()
      .then((symbols) => { if (!cancelled) setIsFno(symbols.has(symbol)); })
      .catch(() => { if (!cancelled) setIsFno(false); });
    return () => { cancelled = true; };
  }, [symbol]);

  return <div className="mx-auto max-w-[1500px] space-y-4">
    <div className="rounded-xl bg-card p-4 shadow-sm">
      <Link href="/pulse/intraday" className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-accent"><ArrowLeft size={14} /> Intraday stocks</Link>
      <div className="grid gap-4 xl:grid-cols-[minmax(190px,.7fr)_minmax(0,2fr)_auto] xl:items-center">
        <div><div className="flex items-center gap-3"><h1 className="font-mono text-2xl font-black text-text-heading">{symbol}</h1><span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-extrabold text-warning">P</span>{data && <span className={cn("rounded-md px-2 py-1 text-xs font-semibold", data.marketHours ? "bg-profit-bg text-profit" : "bg-surface-hover text-muted")}>{data.marketHours ? "● Live" : "Market closed"}</span>}</div><p className="mt-1 text-sm text-muted">Full NSE session · close-confirmed signals</p></div>
        {data ? <div className="grid gap-2 sm:grid-cols-3">{(data.direction === "SHORT" ? ["FIVE_MIN_BREAKDOWN", "FIFTEEN_MIN_BREAKDOWN", "PREVIOUS_DAY_LOW_BREAK"] : ["FIVE_MIN_BREAKOUT", "FIFTEEN_MIN_BREAKOUT", "PREVIOUS_DAY_HIGH_BREAK"]).map((type) => <SignalTime key={type} type={type as ChartSignal["type"]} signal={data.signals.find((item) => item.type === type)} />)}</div> : <div className="h-16 animate-pulse rounded-lg bg-surface-hover" />}
        <div className="flex flex-wrap items-center gap-2 xl:justify-end">{isFno && <Link href={`/radar-trade?symbol=${encodeURIComponent(symbol)}&view=options&from=intraday`} className="workspace-button">F&amp;O / OI <ArrowUpRight size={14} /></Link>}<Link href={`/radar-trade?symbol=${encodeURIComponent(symbol)}&view=trade&from=intraday`} className="workspace-button">Trade view <ArrowUpRight size={14} /></Link><label className="text-xs font-semibold text-muted" htmlFor="chart-timeframe">Candles</label><select id="chart-timeframe" value={timeframe} onChange={(event) => setTimeframe(Number(event.target.value) as 5 | 15)} className="h-9 rounded-lg border border-card-border bg-page-bg px-3 text-sm font-bold text-foreground focus:border-accent focus:outline-none"><option value={5}>5M</option><option value={15}>15M</option></select><button type="button" onClick={() => void load()} disabled={loading} className="workspace-button"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button></div>
      </div>
    </div>

    {error && <div role="alert" className="rounded-lg bg-loss-bg px-4 py-3 text-sm text-loss">{error}</div>}
    <div className="rounded-xl bg-card p-3 shadow-sm sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs"><span className="font-bold text-text-heading">{timeframe}M chart</span>{data?.direction === "SHORT" && data.previousDayLow != null ? <span className="rounded bg-loss-bg px-2 py-1 font-semibold text-loss">PDL ₹{data.previousDayLow.toLocaleString("en-IN")}</span> : data?.previousDayHigh != null && <span className="rounded bg-warning/15 px-2 py-1 font-semibold text-warning">PDH ₹{data.previousDayHigh.toLocaleString("en-IN")}</span>}{(data?.formingBreakout || data?.formingBreakdown) && <span className="rounded bg-warning/15 px-2 py-1 font-semibold text-warning">Breaking now · awaiting close</span>}{data?.candles.at(-1)?.isForming && <span className="rounded bg-accent-bg px-2 py-1 font-semibold text-accent">Current candle forming</span>}<span className="ml-auto text-muted">{data ? `${data.candles.length} candles · ${formatTime(data.updatedAt)}` : ""}</span></div>
      {loading && !data ? <div className="flex h-[520px] items-center justify-center text-sm text-muted"><RefreshCw className="mr-2 animate-spin" size={16} /> Loading chart...</div> : data && data.candles.length > 0 ? <CandleChart data={data} /> : <div className="flex h-[420px] items-center justify-center text-sm text-muted">No candles are stored for this session.</div>}
    </div>

    <div className="flex items-start gap-2 rounded-xl bg-card px-4 py-3 text-xs leading-5 text-muted shadow-sm"><Clock3 size={15} className="mt-0.5 shrink-0 text-accent" /><p>The monitor reads the shared 1-minute market feed every {data?.method.evaluationCadenceSeconds ?? 30} seconds. Session history is hydrated from Zerodha first, with the configured Runner provider used only as fallback. A move may appear as <b className="text-warning">breaking now</b>, but 5M and 15M signals are confirmed only after their candles close.</p></div>
  </div>;
}

function CandleChart({ data }: { data: ChartResponse }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const formatChartTime = (time: Time) => {
      const epoch = typeof time === "number"
        ? time
        : typeof time === "string"
          ? new Date(`${time}T00:00:00Z`).getTime() / 1000
          : Date.UTC(time.year, time.month - 1, time.day) / 1000;
      return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date(epoch * 1000));
    };
    const chart = createChart(host.current, { width: host.current.clientWidth, height: 520, layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#64748b", fontFamily: "Inter, ui-sans-serif, system-ui" }, localization: { timeFormatter: formatChartTime }, grid: { vertLines: { color: "rgba(148,163,184,.12)" }, horzLines: { color: "rgba(148,163,184,.12)" } }, rightPriceScale: { borderVisible: false, scaleMargins: { top: .08, bottom: .12 } }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2, barSpacing: data.timeframeMinutes === 5 ? 8 : 15, tickMarkFormatter: formatChartTime } });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, { upColor: "#07946b", downColor: "#df4d5a", borderUpColor: "#07946b", borderDownColor: "#df4d5a", wickUpColor: "#07946b", wickDownColor: "#df4d5a", priceLineVisible: true });
    series.setData(data.candles.map((candle) => ({ time: Math.floor(new Date(candle.time).getTime() / 1000) as UTCTimestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close, ...(candle.isForming ? { color: "#d99a20", borderColor: "#d99a20", wickColor: "#d99a20" } : {}) })));
    if (data.previousDayHigh != null) series.createPriceLine({ price: data.previousDayHigh, color: "#d99000", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "PDH" });
    if (data.previousDayLow != null) series.createPriceLine({ price: data.previousDayLow, color: "#dc5966", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "PDL" });
    const fiveMinute = data.signals.find((signal) => signal.type === (data.direction === "SHORT" ? "FIVE_MIN_BREAKDOWN" : "FIVE_MIN_BREAKOUT"));
    if (fiveMinute?.breakoutLevel != null) series.createPriceLine({ price: fiveMinute.breakoutLevel, color: "#2563eb", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "5M" });
    const fifteenMinute = data.signals.find((signal) => signal.type === (data.direction === "SHORT" ? "FIFTEEN_MIN_BREAKDOWN" : "FIFTEEN_MIN_BREAKOUT"));
    if (fifteenMinute?.breakoutLevel != null) series.createPriceLine({ price: fifteenMinute.breakoutLevel, color: "#059669", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "15M" });
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => { if (host.current) chart.applyOptions({ width: host.current.clientWidth }); }); observer.observe(host.current);
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null; };
  }, [data]);
  return <div ref={host} className="h-[520px] w-full" aria-label={`${data.symbol} ${data.timeframeMinutes}-minute candlestick chart`} />;
}

function SignalTime({ type, signal }: { type: ChartSignal["type"]; signal?: ChartSignal }) {
  const label = type.includes("FIVE") ? "5M" : type.includes("FIFTEEN") ? "15M" : type.includes("LOW") ? "PDL" : "PDH";
  const bearish = type.includes("BREAKDOWN") || type.includes("LOW");
  const tone = bearish ? "text-loss" : type === "FIVE_MIN_BREAKOUT" ? "text-accent" : type === "FIFTEEN_MIN_BREAKOUT" ? "text-profit" : "text-warning";
  return <div className="min-w-0 rounded-lg bg-surface-hover/70 px-3 py-2.5"><div className="flex items-center justify-between gap-2"><span className="text-[11px] font-bold text-muted">{label}</span><span className={cn("font-mono text-sm font-black", signal ? tone : "text-muted")}>{signal ? formatTime(signal.signalTime) : "Not confirmed"}</span></div>{signal && <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-muted"><span>Level {price(signal.breakoutLevel)}</span><span>Confirmed {price(signal.triggerPrice)}</span><span>Best <b className={returnTone(signal.bestReturnPct ?? signal.highReturnPct)}>{percent(signal.bestReturnPct ?? signal.highReturnPct)}</b></span><span>Close <b className={returnTone(signal.closeReturnPct)}>{percent(signal.closeReturnPct)}</b></span></div>}</div>;
}
function formatTime(value: string) { return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).format(new Date(value)); }
function price(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function percent(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`; }
function returnTone(value?: number | null) { return value == null ? "text-muted" : value >= 0 ? "text-profit" : "text-loss"; }
