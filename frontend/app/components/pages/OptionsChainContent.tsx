"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Radio, RefreshCw } from "lucide-react";
import { fetchAPI } from "../../lib/api";
import { OptionsAnalyticsBar } from "../options/OptionsAnalyticsBar";
import { FallCaptureCard } from "../options/FallCaptureCard";
import { OptionChainTable } from "../options/OptionChainTable";
import { OIClockView } from "../options/OIClockView";
import { OIHistoryPanel } from "../options/OIHistoryPanel";
import { OptionsDirectionPanel } from "../options/OptionsDirectionPanel";
import { OptionsTradeDecisionCard } from "../options/OptionsTradeDecisionCard";
import { SqueezeAlert } from "../options/SqueezeAlert";
import { useOptionsSocket } from "../../hooks/useOptionsSocket";
import { cn, isMarketOpen } from "../../lib/utils";
import { useAuth } from "../../contexts/AuthContext";
import { SubTabs } from "../layout/SubTabs";
import { PremiumBadge, PremiumLocked } from "../premium/PremiumBadge";

const INDICES = [
  { key: "nifty", label: "NIFTY" },
  { key: "banknifty", label: "BANKNIFTY" },
  { key: "finnifty", label: "FINNIFTY" },
  { key: "midcpnifty", label: "MIDCPNIFTY" },
  { key: "sensex", label: "SENSEX" },
];

const LIVE_CHAIN_REFRESH_MS = 180000;
const POLLING_CHAIN_REFRESH_MS = 90000;
const REQUEST_COOLDOWN_MS = 45000;

function formatOptionsError(err: any): string {
  const raw = String(err?.message || err || "");
  const message = raw.replace(/^API error\s+\d+:\s*/i, "").trim();
  const normalized = raw.toLowerCase();
  if (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("ratelimit") ||
    normalized.includes("429")
  ) {
    return "Live options feed is rate-limited. Showing the latest available chain; retry after a minute.";
  }
  return message || "Options feed is temporarily unavailable. Please retry shortly.";
}

export default function OptionsChainContent() {
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;
  const [selectedIndex, setSelectedIndex] = useState("nifty");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [view, setView] = useState<"chain" | "clock" | "change">("chain");
  const [analysisView, setAnalysisView] = useState<"chain" | "decision" | "direction" | "fall" | "squeeze">("chain");
  const selectedIndexRef = useRef(selectedIndex);
  const dataRef = useRef<any>(null);
  const inFlightRef = useRef<Record<string, Promise<void> | undefined>>({});
  const lastLoadRef = useRef<Record<string, number>>({});

  const { connected, optionsTicks, subscribeOptions, unsubscribeAll } =
    useOptionsSocket();

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const subscribeChain = useCallback((chain: any[]) => {
    unsubscribeAll();
    const tokens: number[] = [];
    for (const strike of chain) {
      if (strike.call?.token) tokens.push(strike.call.token);
      if (strike.put?.token) tokens.push(strike.put.token);
    }
    if (tokens.length > 0) subscribeOptions(tokens);
  }, [subscribeOptions, unsubscribeAll]);

  const loadChain = useCallback(async (
    index: string,
    options: { force?: boolean; background?: boolean } = {},
  ) => {
    const currentData = dataRef.current;
    const hasCurrentData = Boolean(currentData?.chain?.length);
    const now = Date.now();
    const lastLoad = lastLoadRef.current[index] || 0;

    if (!options.force && hasCurrentData && now - lastLoad < REQUEST_COOLDOWN_MS) {
      return;
    }

    const running = inFlightRef.current[index];
    if (running) {
      await running;
      return;
    }

    const task = (async () => {
      if (!options.background || !hasCurrentData) setLoading(true);
      if (!options.background) {
        setError(null);
        setNotice(null);
      }

      try {
        const res = await fetchAPI(`/api/options/${index}`);
        if (selectedIndexRef.current !== index) return;
        if (res.success) {
          lastLoadRef.current[index] = Date.now();
          setData(res);
          dataRef.current = res;
          setError(null);
          setNotice(res.warning || (res.stale ? "Showing cached options chain while live feed recovers." : null));
          if (liveMode) subscribeChain(res.chain || []);
          return;
        }

        const message = res.error || "Failed to load options chain.";
        if (dataRef.current?.chain?.length) {
          setNotice(message);
          setError(null);
        } else {
          setError(message);
        }
      } catch (err: any) {
        if (selectedIndexRef.current !== index) return;
        const message = formatOptionsError(err);
        if (dataRef.current?.chain?.length) {
          setNotice(message);
          setError(null);
        } else {
          setError(message);
        }
      } finally {
        if (selectedIndexRef.current === index) setLoading(false);
      }
    })();

    inFlightRef.current[index] = task;
    try {
      await task;
    } finally {
      if (inFlightRef.current[index] === task) delete inFlightRef.current[index];
    }
  }, [liveMode, subscribeChain]);

  useEffect(() => {
    loadChain(selectedIndex, { force: true });
    return () => unsubscribeAll();
  }, [loadChain, selectedIndex, unsubscribeAll]);

  const liveChain = useMemo(() => {
    if (!data?.chain || optionsTicks.size === 0) return data?.chain;
    return data.chain.map((strike: any) => {
      const updated = { ...strike };
      if (strike.call?.token) {
        const tick = optionsTicks.get(strike.call.token);
        if (tick) {
          updated.call = { ...strike.call, ltp: tick.last, volume: tick.volume, oi: tick.oi, oiChange: tick.oi - (tick.oiDayLow || tick.oi) };
        }
      }
      if (strike.put?.token) {
        const tick = optionsTicks.get(strike.put.token);
        if (tick) {
          updated.put = { ...strike.put, ltp: tick.last, volume: tick.volume, oi: tick.oi, oiChange: tick.oi - (tick.oiDayLow || tick.oi) };
        }
      }
      return updated;
    });
  }, [data?.chain, optionsTicks]);

  const liveAnalytics = useMemo(() => {
    if (!data?.analytics || !liveChain) return data?.analytics;
    const totalCallOI = liveChain.reduce((s: number, r: any) => s + (r.call?.oi || 0), 0);
    const totalPutOI = liveChain.reduce((s: number, r: any) => s + (r.put?.oi || 0), 0);
    const pcr = totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(2) : 0;
    return { ...data.analytics, totalCallOI, totalPutOI, pcr, pcrSentiment: pcr > 1.3 ? "BULLISH" : pcr < 0.7 ? "BEARISH" : "NEUTRAL" };
  }, [data?.analytics, liveChain]);

  const liveSpot = useMemo(() => data?.spot, [data?.spot]);

  useEffect(() => {
    const interval = setInterval(
      () => loadChain(selectedIndex, { background: true }),
      liveMode ? LIVE_CHAIN_REFRESH_MS : POLLING_CHAIN_REFRESH_MS,
    );
    return () => clearInterval(interval);
  }, [liveMode, loadChain, selectedIndex]);

  const changeIndex = (nextIndex: string) => {
    if (selectedIndex === nextIndex) return;
    selectedIndexRef.current = nextIndex;
    dataRef.current = null;
    setData(null);
    setNotice(null);
    setError(null);
    setSelectedIndex(nextIndex);
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex min-w-0 flex-col gap-4 rounded-xl bg-card p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs font-bold">
            <span className={cn("w-2 h-2 rounded-full",
              !isMarketOpen() ? "bg-yellow-500" :
              connected && liveMode ? "bg-profit animate-pulse" : "bg-muted"
            )} />
            <span className={
              !isMarketOpen() ? "text-yellow-500" :
              connected && liveMode ? "text-profit" : "text-muted"
            }>
              {!isMarketOpen() ? "Last Session" : connected && liveMode ? "LIVE" : "Polling"}
            </span>
          </div>
          <button type="button"
            onClick={() => {
              const nextLiveMode = !liveMode;
              setLiveMode(nextLiveMode);
              if (nextLiveMode && dataRef.current?.chain) {
                subscribeChain(dataRef.current.chain);
              } else {
                unsubscribeAll();
              }
            }}
            className={cn("workspace-button min-h-10 font-bold", liveMode ? "text-profit" : "text-muted")}
          >
            {liveMode ? <Radio size={14} /> : <Pause size={14} />}{liveMode ? "Streaming" : "Paused"}
          </button>
          <button type="button"
            onClick={() => loadChain(selectedIndex, { force: true })}
            disabled={loading}
            className="workspace-button min-h-10 font-bold disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin motion-reduce:animate-none" : ""} />{loading ? "Loading" : "Refresh"}
          </button>
        </div><p className="mt-2 text-xs text-muted">One shared chain powers the table, OI Clock, and stored OI Change history.</p></div>
        <label className="flex min-w-[220px] flex-col gap-1.5 text-[10px] font-black uppercase tracking-[0.13em] text-muted" htmlFor="options-index">Underlying<select id="options-index" value={selectedIndex} onChange={(event) => changeIndex(event.target.value)} className="min-h-11 cursor-pointer rounded-lg border border-card-border bg-page-bg px-3 text-sm font-black tracking-normal text-text-heading outline-none focus:border-accent focus:ring-2 focus:ring-accent/20">{INDICES.map((index) => <option key={index.key} value={index.key}>{index.label}</option>)}</select></label>
      </div>

      {notice && (
        <div className="bg-warning/10 border border-warning/30 rounded-xl p-4 text-warning text-sm">
          {notice}
        </div>
      )}

      {error && !data && (
        <div className="bg-loss-bg border border-loss/20 rounded-xl p-4 text-loss text-sm">{error}</div>
      )}

      {data && (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-1 text-xs font-semibold text-muted">
            <span>Expiry: <strong className="text-foreground">{data.expiry}</strong></span>
            <span>Lot Size: <strong className="text-foreground">{data.lotSize}</strong></span>
            {data.provider?.provider && (
              <span className={cn(
                "font-semibold uppercase",
                data.provider.provider === "arrow" ? "text-profit" : data.provider.fallback ? "text-warning" : "text-muted",
              )}>
                {data.provider.provider}{data.provider.fallback ? " fallback" : ""}
                {data.provider.elapsedMs ? ` / ${Math.round(data.provider.elapsedMs)} ms` : ""}
              </span>
            )}
            {data.cached && <span className="text-warning">{data.stale ? "cached fallback" : "cached"}</span>}
            {typeof data.cachedAgeSeconds === "number" && <span>Age: {data.cachedAgeSeconds}s</span>}
            <span>Updated: {new Date(data.timestamp).toLocaleTimeString("en-IN")}</span>
            {connected && liveMode && (
              <span className="text-profit">Streaming {optionsTicks.size} tokens</span>
            )}
          </div>

          <OptionsAnalyticsBar analytics={liveAnalytics} spot={liveSpot} />
          <SubTabs tabs={[
            { key: "chain", label: "Option chain" },
            { key: "decision", label: "Trade decision" },
            { key: "direction", label: "Greeks & direction" },
            { key: "fall", label: "Fall capture" },
            { key: "squeeze", label: "Squeeze monitor" },
          ]} active={analysisView} onChange={setAnalysisView} />
          {analysisView === "decision" && <OptionsTradeDecisionCard decision={data.tradeDecision} name={data.name} />}
          {analysisView === "direction" && <OptionsDirectionPanel direction={data.direction} name={data.name} />}
          {analysisView === "fall" && <FallCaptureCard signal={data.fallCapture} name={data.name} />}
          <div hidden={analysisView !== "squeeze"}><SqueezeAlert indexKey={selectedIndex} /></div>

          {analysisView === "chain" && <>
          <div className="flex min-w-0 items-center gap-2">
            <div className="inline-flex gap-1 rounded-xl bg-surface-hover p-1 shadow-sm" role="group" aria-label="Options data view">
              <button onClick={() => setView("chain")}
                className={cn("min-h-10 rounded-lg px-3 py-2 text-xs font-black transition-colors",
                  view === "chain" ? "bg-card text-accent shadow-sm" : "text-muted hover:text-foreground")}>
                Chain
              </button>
              <button onClick={() => setView("clock")}
                className={cn("min-h-10 rounded-lg px-3 py-2 text-xs font-black transition-colors",
                  view === "clock" ? "bg-card text-accent shadow-sm" : "text-muted hover:text-foreground")}>
                <span className="inline-flex items-center gap-1.5">
                  OI Clock
                  <PremiumBadge />
                </span>
              </button>
              <button onClick={() => setView("change")}
                className={cn("min-h-10 rounded-lg px-3 py-2 text-xs font-black transition-colors",
                  view === "change" ? "bg-card text-accent shadow-sm" : "text-muted hover:text-foreground")}>
                <span className="inline-flex items-center gap-1.5">OI Change<PremiumBadge /></span>
              </button>
            </div>
          </div>

          {view === "chain" && (
            <div className="min-w-0 overflow-hidden rounded-xl bg-card shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border/60 px-4 py-3">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-loss">CALLS</span>
                  <span className="text-xs text-muted">Total OI: {(liveAnalytics.totalCallOI / 100000).toFixed(1)}L</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted">Total OI: {(liveAnalytics.totalPutOI / 100000).toFixed(1)}L</span>
                  <span className="text-sm font-medium text-profit">PUTS</span>
                </div>
              </div>
              <OptionChainTable chain={liveChain || data.chain} spot={liveSpot} strikeStep={data.strikeStep} />
            </div>
          )}

          {view === "clock" && isPremium && (
            <div className="min-w-0">
              <OIClockView
                chain={liveChain || data.chain}
                spot={liveSpot}
                strikeStep={data.strikeStep}
                expiry={data.expiry}
                timestamp={data.timestamp}
                isLive={isMarketOpen() && connected && liveMode}
                analytics={liveAnalytics}
              />
            </div>
          )}

          {view === "change" && isPremium && <OIHistoryPanel indexKey={selectedIndex} expiry={data.expiry} chain={liveChain || data.chain} spot={liveSpot} />}

          {(view === "clock" || view === "change") && !isPremium && (
            <PremiumLocked
              title={`${view === "clock" ? "OI Clock" : "OI Change"} is Premium`}
              description={view === "clock" ? "Unlock strike-by-strike positioning, support and resistance pressure, and live buildup context." : "Unlock the stored session chart, PCR trend, and five-minute strike-level OI evidence."}
            />
          )}
          </>}
        </>
      )}

      {loading && !data && (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-12 bg-card border border-card-border rounded-xl animate-pulse" />
          ))}
        </div>
      )}
    </div>
  );
}
