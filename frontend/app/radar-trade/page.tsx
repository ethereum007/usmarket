"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  CandlestickChart,
  Crosshair,
  Gauge,
  Layers3,
  ListTree,
  Radio,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { fetchAPI, postAPI } from "../lib/api";
import { cn } from "../lib/utils";
import { SwingPlanContext } from "../components/pages/SwingPlanContext";
import FnoStockApex from "../components/pages/FnoStockApex";
import {
  appendSnapshot,
  computeDepth,
  computeOiContext,
  type ArrowQuoteResponse,
  type FnoChainResponse,
  type RadarCandidate,
  type RadarResponse,
  TradeDecisionPanel,
  type TradeDetailState,
} from "../components/pages/PulseContent";

const STORAGE_KEY = "alpha-radar:selected-candidate";

export default function RadarTradePage() {
  return (
    <Suspense fallback={<RadarTradeLoading />}>
      <RadarTradeContent />
    </Suspense>
  );
}

function RadarTradeLoading() {
  return (
    <div className="max-w-[1500px] mx-auto">
      <div className="h-[360px] bg-card border border-card-border rounded-lg animate-pulse flex items-center justify-center text-sm text-muted">
        Loading Radar trade...
      </div>
    </div>
  );
}

function RadarTradeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const symbol = (searchParams.get("symbol") || "").toUpperCase();
  const planId = searchParams.get("plan");
  const planRevision = searchParams.get("revision") || "1";
  const requestedView = searchParams.get("view");
  const fromIntraday = searchParams.get("from") === "intraday";
  const workspaceUrl = (view: "trade" | "chart" | "options") => `/radar-trade?symbol=${encodeURIComponent(symbol)}&view=${view}${fromIntraday ? "&from=intraday" : ""}`;
  const activeView: "trade" | "chart" | "options" = requestedView === "chart" || requestedView === "options" ? requestedView : "trade";
  const [candidate, setCandidate] = useState<RadarCandidate | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(true);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [tradeDetail, setTradeDetail] = useState<TradeDetailState>({
    quote: null,
    quoteMeta: null,
    chain: null,
    loading: false,
    error: null,
    spreadHistory: [],
    oiHistory: [],
  });

  useEffect(() => {
    let cancelled = false;

    async function loadCandidate() {
      setCandidateLoading(true);
      setCandidateError(null);
      try {
        const stored = window.sessionStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as RadarCandidate;
          if (!symbol || parsed.symbol.toUpperCase() === symbol) {
            if (!cancelled) {
              setCandidate(parsed);
              setCandidateLoading(false);
            }
            return;
          }
        }

        if (!symbol) {
          throw new Error("Missing symbol.");
        }

        const res = await postAPI<RadarResponse>("/api/intraday/radar", {
          symbols: [symbol],
          minTradedValueLakh: 0,
          useCache: true,
          quoteProvider: "arrow_first",
        });
        const freshCandidate = res.candidates?.find((item) => item.symbol.toUpperCase() === symbol) || null;
        if (!freshCandidate) {
          if (!cancelled) setCandidate(createSymbolFallbackCandidate(symbol));
          return;
        }
        if (!cancelled) setCandidate(freshCandidate);
      } catch (err) {
        if (!cancelled) {
          setCandidate(null);
          setCandidateError(err instanceof Error ? err.message : "Could not load Radar trade.");
        }
      } finally {
        if (!cancelled) setCandidateLoading(false);
      }
    }

    loadCandidate();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    if (!candidate || activeView !== "trade") return;

    let cancelled = false;
    const selectedSymbol = candidate.symbol;

    async function loadTradeDetail(isInitial = false) {
      if (isInitial) {
        setTradeDetail({
          symbol: selectedSymbol,
          quote: null,
          quoteMeta: null,
          chain: null,
          loading: true,
          error: null,
          spreadHistory: [],
          oiHistory: [],
        });
      } else {
        setTradeDetail((prev) => ({ ...prev, loading: true, error: null }));
      }

      try {
        const [quoteRes, chainRes] = await Promise.allSettled([
          postAPI<ArrowQuoteResponse>("/api/arrow/quotes", {
            symbols: [selectedSymbol],
            exchange: "NSE",
            mode: "full",
          }),
          fetchAPI<FnoChainResponse>(`/api/fno/chain/${encodeURIComponent(selectedSymbol)}`),
        ]);

        if (cancelled) return;
        const quote =
          quoteRes.status === "fulfilled"
            ? quoteRes.value.data?.[`NSE:${selectedSymbol}`] || null
            : null;
        const chain = chainRes.status === "fulfilled" && chainRes.value.success ? chainRes.value : null;
        const depthSnapshot = computeDepth(quote);
        const oiSnapshot = computeOiContext(chain);
        const errors = [
          quoteRes.status === "rejected" ? "Arrow depth unavailable" : "",
          chainRes.status === "rejected" ? "F&O/OI chain unavailable" : "",
        ].filter(Boolean);

        setTradeDetail((prev) => {
          const sameSymbol = prev.symbol === selectedSymbol;
          return {
            symbol: selectedSymbol,
            quote,
            quoteMeta: quoteRes.status === "fulfilled" ? quoteRes.value.meta || null : null,
            chain,
            loading: false,
            error: errors.length ? errors.join(" | ") : null,
            spreadHistory: appendSnapshot(
              sameSymbol ? prev.spreadHistory : [],
              {
                ts: Date.now(),
                spreadPct: depthSnapshot.spreadPct,
                bidQty: depthSnapshot.bidQty,
                askQty: depthSnapshot.askQty,
              },
              12,
            ),
            oiHistory: appendSnapshot(
              sameSymbol ? prev.oiHistory : [],
              {
                ts: Date.now(),
                pcr: oiSnapshot.pcr,
                callChange: oiSnapshot.callChange,
                putChange: oiSnapshot.putChange,
              },
              12,
            ),
          };
        });
      } catch (err) {
        if (!cancelled) {
          setTradeDetail((prev) => ({
            ...prev,
            symbol: selectedSymbol,
            quote: null,
            quoteMeta: null,
            chain: null,
            loading: false,
            error: err instanceof Error ? err.message : "Could not load trade detail",
          }));
        }
      }
    }

    loadTradeDetail(true);
    const timer = window.setInterval(() => loadTradeDetail(false), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeView, candidate]);

  const depth = candidate ? computeDepth(tradeDetail.quote) : null;
  const oi = candidate ? computeOiContext(tradeDetail.chain) : null;

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      {planId && <SwingPlanContext planId={planId} revision={planRevision} symbol={symbol} price={tradeDetail.quote?.last_price ?? null} />}
      <TradeCockpitHeader
        candidate={candidate}
        loading={candidateLoading}
        detail={tradeDetail}
        depth={depth}
        oi={oi}
        symbol={symbol}
        activeView={activeView}
        fromIntraday={fromIntraday}
        onViewChange={(view) => router.replace(workspaceUrl(view), { scroll: false })}
      />

      {candidateLoading && activeView === "trade" && (
        <div className="h-[360px] bg-card border border-card-border rounded-lg animate-pulse flex items-center justify-center text-sm text-muted">
          Loading Radar trade...
        </div>
      )}

      {candidateError && !candidateLoading && activeView === "trade" && (
        <div className="bg-loss-bg border border-loss/20 rounded-lg p-5 text-loss text-sm">
          {candidateError}
        </div>
      )}

      {candidate && !candidateLoading && activeView === "trade" && (
        <TradeDecisionPanel
          candidate={planId ? { ...candidate, researchOnly: true } : candidate}
          detail={tradeDetail}
          onClose={() => router.push(fromIntraday ? "/pulse/intraday" : "/pulse")}
          showHeader={false}
          showFeedWarning={false}
          showOiClock={false}
        />
      )}

      {symbol && activeView !== "trade" && (
        <FnoStockApex
          symbol={symbol}
          view={activeView}
          embedded
          onBack={() => router.push(fromIntraday ? "/pulse/intraday" : "/fno")}
          onViewChange={(view) => router.replace(workspaceUrl(view), { scroll: false })}
        />
      )}
    </div>
  );
}

function TradeCockpitHeader({
  candidate,
  loading,
  detail,
  depth,
  oi,
  symbol,
  activeView,
  fromIntraday,
  onViewChange,
}: {
  candidate: RadarCandidate | null;
  loading: boolean;
  detail: TradeDetailState;
  depth: ReturnType<typeof computeDepth> | null;
  oi: ReturnType<typeof computeOiContext> | null;
  symbol: string;
  activeView: "trade" | "chart" | "options";
  fromIntraday: boolean;
  onViewChange: (view: "trade" | "chart" | "options") => void;
}) {
  const biasTone = candidate?.bias === "LONG" ? "profit" : candidate?.bias === "SHORT" ? "loss" : "warning";
  const signalLabel = candidate ? decisionLabel(candidate) : loading ? "Loading" : "No Setup";
  const signalTone = candidate ? decisionTone(candidate) : "warning";
  const dataLabel = detail.loading ? "Refreshing" : detail.error ? "Partial Data" : detail.quote || detail.chain ? "Live Context" : "Waiting";
  const dataTone = detail.error ? "warning" : detail.quote || detail.chain ? "profit" : "neutral";
  const spreadLabel = depth?.spreadPct == null ? "-" : `${depth.spreadPct.toFixed(2)}%`;
  const spreadTone = depth?.spreadPct == null ? "neutral" : depth.spreadOk ? "profit" : "warning";
  const oiLabel = oi?.stance || "No F&O Data";
  const oiTone = oi?.stanceTone || "neutral";
  const TrendIcon = candidate?.bias === "SHORT" ? TrendingDown : candidate?.bias === "LONG" ? TrendingUp : Crosshair;

  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-sm">
      <div className="flex flex-col gap-4 border-b border-card-border px-4 py-4 min-[1500px]:flex-row min-[1500px]:items-center min-[1500px]:justify-between">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Link href={fromIntraday ? "/pulse/intraday" : "/"} className="inline-flex items-center gap-1 text-muted hover:text-accent">
              <ArrowLeft className="h-3.5 w-3.5" />
              {fromIntraday ? "Intraday stocks" : "Today"}
            </Link>
            {!fromIntraday && <><span className="text-muted">/</span><Link href="/pulse" className="text-muted hover:text-accent">Alpha Radar</Link></>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className={cn("flex h-11 w-11 items-center justify-center rounded-lg", toneSoftBg(biasTone))}>
              <TrendIcon className={cn("h-5 w-5", toneText(biasTone))} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-mono text-2xl font-black text-text-heading">
                  {candidate?.symbol || symbol || "Trade Cockpit"}
                </h1>
                {candidate && (
                  <>
                    <span className={cn("rounded px-2 py-1 text-[11px] font-black", biasBadge(candidate.bias))}>
                      {candidate.bias}
                    </span>
                    <span className={cn("rounded px-2 py-1 text-[11px] font-black", toneBadge(signalTone))}>
                      {signalLabel}
                    </span>
                  </>
                )}
              </div>
              <p className="mt-1 text-sm text-muted">
                {candidate
                  ? `${candidate.sector || "NSE"} / ${setupText(candidate)}`
                  : activeView === "chart" ? "Intraday price action and momentum." : activeView === "options" ? "Option-chain positioning, OI pressure, and key levels." : "Focused decision page for trend, OI, depth, liquidity, and risk checks."}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 min-[1500px]:min-w-[610px]">
          {symbol && <div className="flex flex-wrap justify-start min-[1500px]:justify-end"><div className="inline-flex rounded-lg bg-surface-hover p-1" aria-label="Stock workspace view">{([
            { key: "chart", label: "Intraday chart", icon: CandlestickChart },
            { key: "options", label: "Option chain & OI", icon: ListTree },
            { key: "trade", label: "Trade setup", icon: Activity },
          ] as const).map(({ key, label, icon: ViewIcon }) => <button key={key} type="button" onClick={() => onViewChange(key)} className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-xs font-bold transition-colors", activeView === key ? "bg-card text-accent shadow-sm" : "text-muted hover:text-text-heading")} aria-pressed={activeView === key}><ViewIcon size={14} />{label}</button>)}</div></div>}
          {activeView === "trade" && <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <HeaderMetric icon={ShieldCheck} label="Signal" value={signalLabel} tone={signalTone} />
            <HeaderMetric icon={Radio} label="Data" value={dataLabel} tone={dataTone} />
            <HeaderMetric icon={Gauge} label="Spread" value={spreadLabel} tone={spreadTone} />
            <HeaderMetric icon={Layers3} label="OI Stance" value={oiLabel} tone={oiTone} />
          </div>}
        </div>
      </div>

      {activeView === "trade" && <div className="grid grid-cols-1 divide-y divide-card-border md:grid-cols-4 md:divide-x md:divide-y-0">
        <QuickContext label="Score" value={candidate ? String(Math.round(candidate.score)) : "-"} tone={candidate ? scoreTone(candidate.score) : "neutral"} />
        <QuickContext label="Entry / Stop" value={candidate ? `${formatPrice(candidate.entry)} / ${formatPrice(candidate.stop)}` : "-"} tone="accent" />
        <QuickContext label="Target / R:R" value={candidate ? `${formatPrice(candidate.target1)} / ${candidate.riskReward ? `1:${candidate.riskReward.toFixed(1)}` : "-"}` : "-"} tone="profit" />
        <QuickContext label="Source" value={candidate ? sourceLabel(candidate) : "-"} tone="neutral" />
      </div>}

      {activeView === "trade" && detail.error && (
        <div className="border-t border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning">
          {detail.error}. Treat decision confidence as reduced until the missing feed recovers.
        </div>
      )}
    </section>
  );
}

function HeaderMetric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone: "profit" | "loss" | "warning" | "accent" | "neutral";
}) {
  return (
    <div className="rounded-lg bg-surface-hover/70 px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] uppercase text-muted">
        <Icon className={cn("h-3.5 w-3.5", toneText(tone))} />
        {label}
      </div>
      <div className={cn("mt-1 truncate font-mono text-sm font-black", toneText(tone))} title={value}>
        {value}
      </div>
    </div>
  );
}

function QuickContext({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "profit" | "loss" | "warning" | "accent" | "neutral";
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] uppercase text-muted">{label}</div>
      <div className={cn("mt-1 truncate font-mono text-sm font-black", toneText(tone))} title={value}>
        {value}
      </div>
    </div>
  );
}

type CockpitTone = "profit" | "loss" | "warning" | "accent" | "neutral";

function decisionLabel(candidate: RadarCandidate): string {
  if (candidate.action === "ACTIONABLE" && candidate.score >= 78 && candidate.quality !== "DATA_CHECK") return "TRADE SETUP";
  if (candidate.score < 45 || candidate.quality === "DATA_CHECK") return "AVOID";
  return "WAIT";
}

function decisionTone(candidate: RadarCandidate): CockpitTone {
  const label = decisionLabel(candidate);
  if (label === "TRADE SETUP") return "profit";
  if (label === "WAIT") return "warning";
  return "loss";
}

function scoreTone(score: number): CockpitTone {
  if (score >= 78) return "profit";
  if (score >= 55) return "warning";
  return "loss";
}

function setupText(candidate: RadarCandidate): string {
  return (candidate.setups || []).slice(0, 2).map((setup) => setup.replaceAll("_", " ")).join(" + ") || "Manual review";
}

function sourceLabel(candidate: RadarCandidate): string {
  const text = `${candidate.setups.join(" ")} ${(candidate.dataWarnings || []).join(" ")}`.toUpperCase();
  if (text.includes("SWING")) return "Swing Radar";
  if (text.includes("ABNORMAL")) return "Abnormal Moves";
  if (text.includes("OI_SIGNAL")) return "OI Signals";
  if (text.includes("MANUAL")) return "Manual Review";
  return "Intraday Radar";
}

function formatPrice(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "-";
  return value.toFixed(2);
}

function biasBadge(bias: RadarCandidate["bias"]): string {
  if (bias === "LONG") return "bg-profit-bg text-profit";
  if (bias === "SHORT") return "bg-loss-bg text-loss";
  return "bg-surface-hover text-muted";
}

function toneText(tone: CockpitTone): string {
  if (tone === "profit") return "text-profit";
  if (tone === "loss") return "text-loss";
  if (tone === "warning") return "text-warning";
  if (tone === "accent") return "text-accent";
  return "text-muted";
}

function toneSoftBg(tone: CockpitTone): string {
  if (tone === "profit") return "bg-profit-bg";
  if (tone === "loss") return "bg-loss-bg";
  if (tone === "warning") return "bg-warning/10";
  if (tone === "accent") return "bg-accent-bg";
  return "bg-surface-hover";
}

function toneBadge(tone: CockpitTone): string {
  if (tone === "profit") return "bg-profit-bg text-profit";
  if (tone === "loss") return "bg-loss-bg text-loss";
  if (tone === "warning") return "bg-warning/10 text-warning";
  if (tone === "accent") return "bg-accent-bg text-accent";
  return "bg-surface-hover text-muted";
}

function createSymbolFallbackCandidate(symbol: string): RadarCandidate {
  return {
    symbol,
    bias: "NEUTRAL",
    score: 0,
    quality: "DATA_CHECK",
    action: "WAIT",
    setups: ["MANUAL_REVIEW"],
    entry: 0,
    stop: null,
    target1: null,
    target2: null,
    riskReward: null,
    invalidation: "No active Radar setup found. Use this page only for quote, depth, OI, and manual review.",
    ltp: 0,
    changePct: 0,
    volume: 0,
    volRatio: 0,
    rFactor: 0,
    vwap: null,
    pdh: null,
    pdl: null,
    sector: "Manual Review",
    freshness: { status: "unknown", ageSeconds: null },
    dataWarnings: ["No active Radar candidate found for this symbol."],
    reasons: ["Opened from a non-Radar source. Confirm setup, liquidity, and risk before acting."],
  };
}
