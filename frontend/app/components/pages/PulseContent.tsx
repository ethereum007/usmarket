"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAPI, postAPI } from "../../lib/api";
import { cn, isMarketOpen } from "../../lib/utils";
import { executionBlockers } from "../../lib/execution-readiness";
import { getIndexMembership, getUniverse, type UniverseKey } from "../../lib/stock-universe";
import { OIClockView } from "../options/OIClockView";

type Bias = "LONG" | "SHORT" | "NEUTRAL";
type DirectionFilter = "all" | Bias;
type DecisionTone = "profit" | "loss" | "warning" | "neutral";
type AlertSyncState = "idle" | "saving" | "synced" | "local" | "error";
type RadarMode = "live" | "snapshot";
type OpportunityView = "best" | "fno" | "cash" | "smallmid" | "nifty50" | "nifty100" | "nifty500";

interface MarketRegime {
  label: string;
  bias: Bias;
  confidence: number;
  breadthPct?: number;
  advancing?: number;
  declining?: number;
  avgChangePct?: number;
  highRvolCount?: number;
  notes: string[];
}

export interface RadarCandidate {
  researchOnly?: boolean;
  symbol: string;
  bias: Bias;
  score: number;
  quality: "A_PLUS" | "A" | "B" | "WATCH" | "DATA_CHECK";
  action: "ACTIONABLE" | "CONFIRM" | "WAIT";
  setups: string[];
  entry: number;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  riskReward: number | null;
  invalidation: string;
  ltp: number;
  changePct: number;
  volume: number;
  tradedValueLakh?: number;
  volRatio: number;
  rFactor: number;
  vwap: number | null;
  pdh: number | null;
  pdl: number | null;
  sector: string;
  freshness: { status: "fresh" | "stale" | "unknown"; ageSeconds: number | null };
  dataWarnings: string[];
  reasons: string[];
}

interface SectorLeadership {
  name: string;
  count: number;
  bias: Bias;
  long: number;
  short: number;
  neutral: number;
  avgChangePct: number;
  avgScore: number;
  highRvol: number;
  leadershipScore: number;
  topStocks: { symbol: string; bias: Bias; score: number; changePct: number }[];
}

export interface RadarResponse {
  success: boolean;
  marketRegime: MarketRegime;
  summary: {
    total: number;
    long: number;
    short: number;
    neutral: number;
    actionable: number;
    avgScore: number;
  };
  sectors: SectorLeadership[];
  candidates: RadarCandidate[];
  actionable: RadarCandidate[];
  watchlist: RadarCandidate[];
  dataQuality: { fresh: number; stale: number; unknown: number; missingStats: number };
  timestamp: number;
  cached?: boolean;
  cachedAt?: string;
  cachedAgeSeconds?: number;
  generatedAt?: string | null;
  nextRefreshAt?: string | null;
  freshness?: { status: "fresh" | "stale" | "pending"; ageSeconds: number | null; source?: string };
  isStale?: boolean;
  refreshQueued?: boolean;
  refreshIntervalSeconds?: number;
  statsCached?: number;
  statsStatus?: {
    cached: number;
    missing: number;
    fetched: number;
    deferred: number;
    source: string;
  };
  provider?: {
    provider: "arrow" | "kite" | string;
    requested?: number;
    returned?: number;
    elapsedMs?: number;
    mode?: string;
    partial?: boolean;
    missing?: number;
    errors?: { symbol?: string; error?: string }[];
    fallback?: boolean;
    fallbackReason?: string;
  };
  filters?: {
    minTradedValueLakh: number;
    inputSymbols: number;
    returnedCandidates: number;
  };
}

interface SnapshotDetailResponse<T> {
  success?: boolean;
  snapshot: {
    key: string;
    label: string;
    status: "fresh" | "last-session" | "stale" | "missing" | "unknown";
    timestamp?: string | null;
    ageLabel?: string | null;
  };
  data: T;
}

interface ArrowDepthLevel {
  price?: number;
  quantity?: number;
  orders?: number;
}

interface ArrowFullQuote {
  last_price?: number;
  average_price?: number;
  volume?: number;
  oi?: number;
  depth?: {
    buy?: ArrowDepthLevel[];
    sell?: ArrowDepthLevel[];
  };
}

export interface ArrowQuoteResponse {
  success: boolean;
  meta?: { elapsedMs?: number; returned?: number; requested?: number };
  data?: Record<string, ArrowFullQuote>;
}

interface ChainStrike {
  strike: number;
  call: { oi: number; oiChange: number; volume: number; ltp: number; iv?: number | null } | null;
  put: { oi: number; oiChange: number; volume: number; ltp: number; iv?: number | null } | null;
}

export interface FnoChainResponse {
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

interface SpreadSnapshot {
  ts: number;
  spreadPct: number | null;
  bidQty: number;
  askQty: number;
}

interface OiSnapshot {
  ts: number;
  pcr: number | null;
  callChange: number;
  putChange: number;
}

export interface TradeDetailState {
  symbol?: string;
  quote: ArrowFullQuote | null;
  quoteMeta: ArrowQuoteResponse["meta"] | null;
  chain: FnoChainResponse | null;
  loading: boolean;
  error: string | null;
  spreadHistory: SpreadSnapshot[];
  oiHistory: OiSnapshot[];
}

const LIVE_SCAN_UNIVERSE: UniverseKey = "nifty500";
const RADAR_CACHE_PREFIX = "alpha-radar:signal-queue:";
const OPPORTUNITY_VIEWS: { key: OpportunityView; label: string; sub: string }[] = [
  { key: "best", label: "Best Now", sub: "All returned liquid names ranked by edge" },
  { key: "fno", label: "F&O", sub: "Derivative-ready, cleaner execution" },
  { key: "cash", label: "Cash", sub: "Non-F&O cash momentum" },
  { key: "smallmid", label: "Small/Mid", sub: "Higher beta, liquidity-aware" },
  { key: "nifty50", label: "N50", sub: "Largecap filter" },
  { key: "nifty100", label: "N100", sub: "Top 100 filter" },
  { key: "nifty500", label: "N500", sub: "Full scan universe" },
];
const ALERT_RULES_KEY = "alpha-radar:alert-rules";

function minTradedValueForUniverse(key: UniverseKey): number {
  if (key === "smallcap") return 50;
  if (key === "microcap") return 20;
  return 0;
}

function membershipSet(key: UniverseKey): Set<string> {
  return new Set(getUniverse(key));
}

const NIFTY50_SET = membershipSet("nifty50");
const NIFTY100_SET = membershipSet("nifty100");
const NIFTY500_SET = membershipSet("nifty500");
const SMALLCAP_SET = membershipSet("smallcap");
const MICROCAP_SET = membershipSet("microcap");

function cleanSymbol(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    .replace(/\.NS$/, "")
    .replace(/-EQ$/, "");
}

function isFnoCandidate(candidate: RadarCandidate): boolean {
  return getIndexMembership(cleanSymbol(candidate.symbol)).includes("F&O");
}

function opportunityScore(candidate: RadarCandidate): number {
  const qualityBoost = candidate.quality === "A_PLUS" ? 16 : candidate.quality === "A" ? 10 : candidate.quality === "B" ? 4 : 0;
  const actionBoost = candidate.action === "ACTIONABLE" ? 12 : candidate.action === "CONFIRM" ? 5 : 0;
  const volumeBoost = Math.min(14, Math.max(0, (candidate.volRatio - 1) * 7));
  const rrBoost = candidate.riskReward ? Math.min(8, Math.max(0, candidate.riskReward * 2)) : 0;
  const liquidityBoost = Math.min(10, Math.max(0, (candidate.tradedValueLakh || 0) / 250));
  const freshPenalty = candidate.freshness.status === "stale" ? 10 : candidate.freshness.status === "unknown" ? 5 : 0;
  const dataPenalty = candidate.quality === "DATA_CHECK" ? 20 : 0;

  return candidate.score + qualityBoost + actionBoost + volumeBoost + rrBoost + liquidityBoost - freshPenalty - dataPenalty;
}

function filterByOpportunityView(candidates: RadarCandidate[], view: OpportunityView): RadarCandidate[] {
  const filtered = candidates.filter((candidate) => {
    const symbol = cleanSymbol(candidate.symbol);
    if (view === "best") return true;
    if (view === "fno") return isFnoCandidate(candidate);
    if (view === "cash") return NIFTY500_SET.has(symbol) && !isFnoCandidate(candidate);
    if (view === "smallmid") return SMALLCAP_SET.has(symbol) || MICROCAP_SET.has(symbol) || (!NIFTY100_SET.has(symbol) && NIFTY500_SET.has(symbol));
    if (view === "nifty50") return NIFTY50_SET.has(symbol);
    if (view === "nifty100") return NIFTY100_SET.has(symbol);
    return NIFTY500_SET.has(symbol);
  });

  return filtered.sort((a, b) => {
    const scoreDiff = opportunityScore(b) - opportunityScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    const actionDiff = Number(b.action === "ACTIONABLE") - Number(a.action === "ACTIONABLE");
    if (actionDiff !== 0) return actionDiff;
    return Math.abs(b.changePct) - Math.abs(a.changePct);
  });
}

function formatVol(v: number): string {
  if (v >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000) return `${(v / 100000).toFixed(1)}L`;
  if (v >= 1000) return `${(v / 1000).toFixed(0)}K`;
  return String(v);
}

function biasClass(bias: Bias): string {
  if (bias === "LONG") return "text-profit bg-profit-bg";
  if (bias === "SHORT") return "text-loss bg-loss-bg";
  return "text-muted bg-surface-hover";
}

function scoreClass(score: number, bias: Bias): string {
  if (bias === "LONG") return score >= 70 ? "text-profit" : "text-accent";
  if (bias === "SHORT") return score >= 70 ? "text-loss" : "text-warning";
  return "text-muted";
}

function qualityClass(quality: RadarCandidate["quality"]): string {
  if (quality === "A_PLUS") return "text-profit bg-profit-bg";
  if (quality === "A") return "text-accent bg-accent-bg";
  if (quality === "B") return "text-warning bg-[rgba(255,193,7,0.1)]";
  if (quality === "DATA_CHECK") return "text-loss bg-loss-bg";
  return "text-muted bg-surface-hover";
}

function qualityLabel(quality: RadarCandidate["quality"]): string {
  if (quality === "A_PLUS") return "A+";
  if (quality === "DATA_CHECK") return "Check";
  return quality;
}

function setupLabel(setup: string): string {
  return setup
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

export default function PulseContent() {
  const [universe, setUniverse] = useState<UniverseKey>(LIVE_SCAN_UNIVERSE);
  const [opportunityView, setOpportunityView] = useState<OpportunityView>("best");
  const [data, setData] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<RadarMode>("live");
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayMeta, setReplayMeta] = useState<SnapshotDetailResponse<RadarResponse>["snapshot"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [search, setSearch] = useState("");
  const [urlReady, setUrlReady] = useState(false);

  const loadRadar = useCallback(async () => {
    try {
      setMode("live");
      setReplayMeta(null);
      setReplayError(null);
      setError(null);
      const symbols = getUniverse(universe);
      const res = await postAPI<RadarResponse>("/api/intraday/radar", {
        symbols,
        minTradedValueLakh: minTradedValueForUniverse(universe),
        useCache: true,
        quoteProvider: "arrow_first",
      });
      if (res.success) {
        setData(res);
        window.sessionStorage.setItem(`${RADAR_CACHE_PREFIX}${universe}`, JSON.stringify(res));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(`Could not load intraday radar. ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [universe]);

  const loadReplay = useCallback(async () => {
    try {
      setReplayLoading(true);
      setReplayError(null);
      setError(null);
      const res = await fetchAPI<SnapshotDetailResponse<RadarResponse>>("/api/snapshots/intraday_radar");
      if (!res.data?.success || !Array.isArray(res.data.candidates)) {
        throw new Error("Saved Intraday Radar payload is not available yet.");
      }
      setData({
        ...res.data,
        candidates: res.data.candidates.map((item) => ({ ...item, researchOnly: true })),
        actionable: (res.data.actionable || []).map((item) => ({ ...item, researchOnly: true })),
        watchlist: (res.data.watchlist || []).map((item) => ({ ...item, researchOnly: true })),
        cached: true,
        cachedAt: res.snapshot.timestamp ?? undefined,
        provider: {
          ...(res.data.provider || {}),
          provider: res.data.provider?.provider || "snapshot",
          fallback: true,
          fallbackReason: `Snapshot replay from ${res.snapshot.ageLabel || "last good scan"}`,
        },
      });
      setReplayMeta(res.snapshot);
      setMode("snapshot");
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "Could not load saved Intraday Radar snapshot";
      const msg = rawMessage.includes("No saved snapshot")
        ? "No saved Intraday Radar replay is available yet. Run one successful live scan during market hours to seed this replay."
        : rawMessage;
      setReplayError(msg);
    } finally {
      setReplayLoading(false);
      setLoading(false);
    }
  }, []);

  const requestRescan = useCallback(async () => {
    try {
      setError(null);
      const result = await postAPI<{ accepted: boolean; message: string }>("/api/market-snapshots/rescan", {
        feed: "intraday",
        symbols: getUniverse(universe),
        minTradedValueLakh: minTradedValueForUniverse(universe),
        useCache: true,
        quoteProvider: "arrow_first",
      });
      setRefreshNote(result.message);
      await loadRadar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue a shared refresh.");
    }
  }, [loadRadar, universe]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view") as OpportunityView | null;
    const view = OPPORTUNITY_VIEWS.some((item) => item.key === requested) ? requested! : "best";
    const requestedDirection = params.get("bias") as DirectionFilter | null;
    const direction = (["all", "LONG", "SHORT", "NEUTRAL"] as const).includes(requestedDirection as DirectionFilter) ? requestedDirection! : "all";
    setOpportunityView(view);
    setDirectionFilter(direction);
    setUniverse(view === "nifty50" ? "nifty50" : view === "nifty100" || view === "fno" ? "nifty100" : "nifty500");
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady || mode === "snapshot") return;
    const cached = window.sessionStorage.getItem(`${RADAR_CACHE_PREFIX}${universe}`);
    if (cached) {
      try { setData(JSON.parse(cached)); } catch {}
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadRadar();
  }, [loadRadar, mode, universe, urlReady]);

  const openTradeDecision = useCallback((candidate: RadarCandidate) => {
    window.sessionStorage.setItem("alpha-radar:selected-candidate", JSON.stringify(candidate));
    window.open(`/radar-trade?symbol=${encodeURIComponent(candidate.symbol)}`, "_self");
  }, []);

  const candidates = useMemo(() => {
    return filterByOpportunityView(data?.candidates || [], opportunityView).filter((candidate) => {
      if (directionFilter !== "all" && candidate.bias !== directionFilter) return false;
      if (search && !candidate.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [data, directionFilter, opportunityView, search]);

  const topLongs = candidates.filter((c) => c.bias === "LONG").slice(0, 8);
  const topShorts = candidates.filter((c) => c.bias === "SHORT").slice(0, 8);
  const activeView = OPPORTUNITY_VIEWS.find((view) => view.key === opportunityView) || OPPORTUNITY_VIEWS[0];
  const switchOpportunityView = useCallback((key: OpportunityView) => {
    setOpportunityView(key);
    const nextUniverse: UniverseKey = key === "nifty50"
      ? "nifty50"
      : key === "nifty100" || key === "fno"
        ? "nifty100"
        : "nifty500";
    setUniverse(nextUniverse);
    setMode("live");
    setReplayMeta(null);
    setReplayError(null);
    const params = new URLSearchParams(window.location.search);
    params.set("view", key);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, []);

  const switchDirection = useCallback((key: DirectionFilter) => {
    setDirectionFilter(key);
    const params = new URLSearchParams(window.location.search);
    if (key === "all") params.delete("bias"); else params.set("bias", key);
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);

  return (
    <div className="space-y-4 rounded-2xl border border-card-border bg-[linear-gradient(180deg,rgba(10,18,32,0.04),rgba(10,18,32,0.01))] p-3 shadow-sm sm:p-4">
      <div className="rounded-xl border border-card-border bg-card/95 p-4 shadow-sm">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_0_4px_rgba(0,153,110,0.12)]" />
              <h2 className="text-base font-black uppercase tracking-wide text-text-heading">Alpha Radar Signal Queue</h2>
            </div>
            <p className="mt-1 text-xs text-muted">
              Best opportunities first across liquid cash and F&O names. Index buckets are filters, not the decision engine.
            </p>
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="flex gap-0.5 rounded-lg border border-card-border bg-page-bg p-0.5">
              <button
                type="button"
                onClick={loadRadar}
                disabled={loading && !data}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-bold transition-colors disabled:opacity-50",
                  mode === "live" ? "bg-accent text-white" : "text-muted hover:text-foreground",
                )}
              >
                Live
              </button>
              <button
                type="button"
                onClick={loadReplay}
                disabled={replayLoading}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-bold transition-colors disabled:opacity-50",
                  mode === "snapshot" ? "bg-warning text-white" : "text-muted hover:text-foreground",
                )}
              >
                {replayLoading ? "Loading" : "Replay"}
              </button>
            </div>
            <button
              type="button"
              onClick={requestRescan}
              disabled={loading && !data}
              className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-bold text-accent transition hover:bg-accent hover:text-white disabled:opacity-50"
            >
              Queue refresh
            </button>
            <input
              type="text"
              placeholder="Search symbol..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full rounded-lg border border-card-border bg-page-bg px-3 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none lg:w-52"
            />
            {data && (
              <span className="whitespace-nowrap rounded-lg border border-card-border bg-page-bg px-3 py-2 text-xs text-muted">
                {data.generatedAt ? `Updated ${snapshotAgeLabel(data.freshness?.ageSeconds)}` : new Date(data.timestamp).toLocaleTimeString("en-IN")}
                {mode === "snapshot" && replayMeta?.ageLabel ? ` | replay ${replayMeta.ageLabel}` : data.cached ? ` | cached ${data.cachedAgeSeconds ?? 0}s` : ""}
                {" | "}{mode === "snapshot" ? "replay" : "manual refresh"}
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-0.5 bg-card border border-card-border rounded-lg p-0.5">
            {OPPORTUNITY_VIEWS.map((view) => (
              <button
                key={view.key}
                onClick={() => switchOpportunityView(view.key)}
                title={view.sub}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-bold transition-colors",
                  opportunityView === view.key ? "bg-accent text-white" : "text-muted hover:text-foreground"
                )}
              >
                {view.label}
              </button>
            ))}
          </div>

          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["all", "LONG", "SHORT", "NEUTRAL"] as DirectionFilter[]).map((filter) => (
              <button
                key={filter}
                onClick={() => switchDirection(filter)}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-medium transition-colors",
                  directionFilter === filter
                    ? filter === "LONG"
                      ? "bg-profit text-white"
                      : filter === "SHORT"
                        ? "bg-loss text-white"
                        : "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {filter === "all" ? "All" : filter}
              </button>
            ))}
          </div>
        </div>

          {data && (
            <div className="grid grid-cols-4 gap-2 text-xs sm:min-w-[460px]">
              <Metric label="View" value={activeView.label} />
              <Metric label="Candidates" value={`${data.summary.total}`} />
              <Metric label="Shown" value={`${candidates.length}`} />
              <Metric label="Regime" value={data.marketRegime.bias} />
            </div>
          )}
        </div>
      </div>

      {(mode === "snapshot" || replayMeta) && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 text-warning text-sm flex flex-col md:flex-row md:items-center justify-between gap-2">
          <span>
            Snapshot replay is active
            {replayMeta?.timestamp ? ` from ${new Date(replayMeta.timestamp).toLocaleString("en-IN")}` : ""}.
            Live refresh is paused until you select Live or change universe.
          </span>
          <a href="/snapshots?key=intraday_radar" className="text-xs font-semibold hover:underline">
            Open raw replay
          </a>
        </div>
      )}

      {error && (
        <div className="bg-loss-bg border border-loss/20 rounded-lg p-3 text-loss text-sm">
          {error}
        </div>
      )}

      {refreshNote && (
        <div className="rounded-lg border border-accent/20 bg-accent/10 p-3 text-sm text-accent">
          {refreshNote}
        </div>
      )}

      {replayError && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 text-warning text-sm">
          {replayError}
        </div>
      )}

      {loading && !data && (
        <div className="h-[360px] bg-card border border-card-border rounded-lg animate-pulse flex items-center justify-center">
          <span className="text-muted">Building intraday radar...</span>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CandidatePanel title="Bullish Setups" candidates={topLongs} onInspect={openTradeDecision} tone="bull" />
            <CandidatePanel title="Bearish Setups" candidates={topShorts} onInspect={openTradeDecision} tone="bear" />
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-hover rounded p-2">
      <div className="text-muted">{label}</div>
      <div className="text-sm font-semibold text-text-heading mt-0.5">{value}</div>
    </div>
  );
}

export function TradeDecisionPanel({
  candidate,
  detail,
  onClose,
  showHeader = true,
  showFeedWarning = true,
  showOiClock = true,
}: {
  candidate: RadarCandidate;
  detail: TradeDetailState;
  onClose: () => void;
  showHeader?: boolean;
  showFeedWarning?: boolean;
  showOiClock?: boolean;
}) {
  const [riskCapital, setRiskCapital] = useState(2500);
  const [alertSaved, setAlertSaved] = useState(false);
  const [alertSyncState, setAlertSyncState] = useState<AlertSyncState>("idle");
  const depth = computeDepth(detail.quote);
  const oi = computeOiContext(detail.chain);
  const liquidity = computeLiquidityScore(candidate, depth);
  const priceLocation = computePriceLocation(candidate);
  const riskPlan = computeRiskPlan(candidate, riskCapital, detail.chain?.lotSize || null);
  const decision = computeTradeDecision(candidate, depth, oi, detail, liquidity, priceLocation);

  useEffect(() => {
    try {
      const rules = JSON.parse(window.localStorage.getItem(ALERT_RULES_KEY) || "[]") as Array<{ symbol?: string }>;
      const saved = rules.some((rule) => rule.symbol === candidate.symbol);
      setAlertSaved(saved);
      setAlertSyncState(saved ? "local" : "idle");
    } catch {
      setAlertSaved(false);
      setAlertSyncState("idle");
    }
  }, [candidate.symbol]);

  async function saveAlertRule() {
    const rule = {
      id: `${candidate.symbol}-${Date.now()}`,
      symbol: candidate.symbol,
      bias: candidate.bias,
      entry: candidate.entry,
      stop: candidate.stop,
      target1: candidate.target1,
      minScore: Math.max(70, candidate.score),
      maxSpreadPct: 0.12,
      createdAt: new Date().toISOString(),
      source: "decision-cockpit",
    };
    let savedLocally = false;
    try {
      const existing = JSON.parse(window.localStorage.getItem(ALERT_RULES_KEY) || "[]") as Array<{ symbol?: string }>;
      const next = [rule, ...existing.filter((item) => item.symbol !== candidate.symbol)].slice(0, 50);
      window.localStorage.setItem(ALERT_RULES_KEY, JSON.stringify(next));
      setAlertSaved(true);
      savedLocally = true;
    } catch {
      setAlertSaved(false);
    }

    setAlertSyncState("saving");
    try {
      await postAPI("/api/alerts/rules", rule);
      setAlertSaved(true);
      setAlertSyncState("synced");
    } catch {
      setAlertSyncState(savedLocally ? "local" : "error");
    }
  }

  return (
    <div className={cn("overflow-hidden", showHeader ? "rounded-xl bg-card shadow-sm" : "bg-transparent")}>
      {showHeader && (
        <div className="px-4 py-3 border-b border-card-border flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xl font-bold text-accent">{candidate.symbol}</span>
              <span className={cn("px-2 py-0.5 rounded text-[10px] font-semibold", biasClass(candidate.bias))}>
                {candidate.bias}
              </span>
              <span className={cn("px-2 py-0.5 rounded text-[10px] font-semibold", decision.toneClass)}>
                {decision.label}
              </span>
            </div>
            <p className="text-xs text-muted mt-1">
              Trade cockpit: Radar setup + Arrow bid/ask depth + F&O OI clock where available.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 rounded border border-card-border text-xs text-muted hover:text-foreground hover:bg-surface-hover"
          >
            Close
          </button>
        </div>
      )}

      <div className={cn("space-y-4", showHeader && "p-4")}>
        {showFeedWarning && detail.error && (
          <div className="bg-warning/10 border border-warning/20 text-warning rounded p-2 text-xs">
            {detail.error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4">
          <div className="space-y-3">
            <div className={cn("rounded-lg border p-4", decision.panelClass)}>
              <div className="text-xs uppercase tracking-wide opacity-80">Decision</div>
              <div className="text-2xl font-bold mt-1">{decision.label}</div>
              <p className="text-sm mt-2">{decision.summary}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 text-xs">
                <TradeMetric label="Score" value={`${candidate.score}`} emphasis />
                <TradeMetric label="Entry" value={candidate.entry.toFixed(2)} />
                <TradeMetric label="Stop" value={candidate.stop ? candidate.stop.toFixed(2) : "-"} />
                <TradeMetric label="R:R" value={candidate.riskReward ? `1:${candidate.riskReward.toFixed(1)}` : "-"} />
              </div>
            </div>

            <div className="bg-surface-hover rounded-lg p-3">
              <div className="text-xs font-semibold text-text-heading mb-2">Why / Why Not</div>
              <div className="space-y-1.5 text-xs">
                {decision.reasons.map((reason) => (
                  <div key={reason} className="flex gap-2">
                    <span className="text-accent">-</span>
                    <span className="text-foreground">{reason}</span>
                  </div>
                ))}
              </div>
            </div>

            <ExecutionChecklist
              candidate={candidate}
              depth={depth}
              oi={oi}
              liquidity={liquidity}
              priceLocation={priceLocation}
              riskPlan={riskPlan}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <DecisionMetric label="Price vs Entry" value={priceLocation.label} tone={priceLocation.tone} />
            <DecisionMetric label="Liquidity Score" value={`${liquidity.score}/100`} tone={liquidity.tone} />
            <DecisionMetric label="Arrow Spread" value={depth.spreadPct == null ? "-" : `${depth.spreadPct.toFixed(2)}%`} tone={depth.spreadOk ? "profit" : "warning"} />
            <DecisionMetric label="Depth Bias" value={depth.biasLabel} tone={depth.depthTone} />
            <DecisionMetric label="Best Bid" value={depth.bestBid ? `${depth.bestBid.price?.toFixed(2)} / ${formatQty(depth.bestBid.quantity || 0)}` : "-"} tone="neutral" />
            <DecisionMetric label="Best Ask" value={depth.bestAsk ? `${depth.bestAsk.price?.toFixed(2)} / ${formatQty(depth.bestAsk.quantity || 0)}` : "-"} tone="neutral" />
            <DecisionMetric label="PCR" value={oi.pcr == null ? "-" : oi.pcr.toFixed(2)} tone={oi.pcrTone} />
            <DecisionMetric label="OI Stance" value={oi.stance} tone={oi.stanceTone} />
            <DecisionMetric label="Call OI" value={oi.totalCallOI == null ? "-" : formatQty(oi.totalCallOI)} tone="loss" />
            <DecisionMetric label="Put OI" value={oi.totalPutOI == null ? "-" : formatQty(oi.totalPutOI)} tone="profit" />
          </div>
        </div>

        <details className="group overflow-hidden rounded-xl bg-card shadow-sm">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-bold text-text-heading hover:bg-hover-bg">
            <span>Execution details &amp; monitoring</span>
            <span className="text-xs font-medium text-muted group-open:hidden">Expand</span>
            <span className="hidden text-xs font-medium text-muted group-open:inline">Collapse</span>
          </summary>
          <div className="space-y-4 border-t border-card-border/60 p-4">
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
          <LiquidityQualityCard liquidity={liquidity} depth={depth} />
          <LiveTapeCard spreadHistory={detail.spreadHistory} oiHistory={detail.oiHistory} bias={candidate.bias} />
          <RiskOrderPreview
            candidate={candidate}
            riskCapital={riskCapital}
            onRiskCapitalChange={setRiskCapital}
            riskPlan={riskPlan}
            decisionLabel={decision.label}
          />
          <AlertRuleCard candidate={candidate} saved={alertSaved} syncState={alertSyncState} onSave={saveAlertRule} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-3 text-xs">
          <SourceContextCard candidate={candidate} />
          <div className="bg-surface-hover rounded p-3">
            <div className="text-muted">Invalidation</div>
            <div className="text-foreground mt-1">{candidate.invalidation}</div>
          </div>
          <div className="bg-surface-hover rounded p-3">
            <div className="text-muted">Execution Rule</div>
            <div className="text-foreground mt-1">
              {candidate.entry > 0
                ? `Enter only near ${candidate.entry.toFixed(2)}. Skip if spread widens or price runs away from entry.`
                : "No trade trigger is active. Use this page for quote, depth, OI, and manual review only."}
            </div>
          </div>
          <div className="bg-surface-hover rounded p-3">
            <div className="text-muted">Data</div>
            <div className="text-foreground mt-1">
              Arrow full quote {detail.quoteMeta?.elapsedMs ? `${Math.round(detail.quoteMeta.elapsedMs)} ms` : detail.loading ? "loading" : "ready"}.
              {detail.chain ? ` F&O expiry ${detail.chain.expiry}.` : " F&O chain unavailable."}
            </div>
          </div>
        </div>
          </div>
        </details>

        {detail.loading && !detail.quote && !detail.chain && (
          <div className="flex min-h-12 items-center gap-3 rounded-lg bg-surface-hover px-4 text-xs text-muted" role="status">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            Loading optional market depth and OI context in the background…
          </div>
        )}

        {showOiClock && detail.chain && (
          <OIClockView
            chain={detail.chain.chain as any}
            spot={detail.chain.spot}
            strikeStep={strikeStep(detail.chain.chain)}
            analytics={oiClockAnalytics(detail.chain)}
          />
        )}
      </div>
    </div>
  );
}

function DecisionMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: DecisionTone;
}) {
  const toneClass =
    tone === "profit" ? "text-profit" :
    tone === "loss" ? "text-loss" :
    tone === "warning" ? "text-warning" :
    "text-foreground";
  return (
    <div className="bg-surface-hover rounded p-3 min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cn("font-mono font-semibold mt-1 truncate", toneClass)} title={value}>
        {value}
      </div>
    </div>
  );
}

function SourceContextCard({ candidate }: { candidate: RadarCandidate }) {
  const context = sourceContext(candidate);
  const freshness = freshnessLabel(candidate.freshness);
  const warningCount = candidate.dataWarnings.length;
  return (
    <div className="bg-surface-hover rounded p-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-muted">Source Context</div>
          <div className="text-foreground mt-1 font-semibold">{context.label}</div>
        </div>
        <span className={cn("px-2 py-0.5 rounded text-[10px] font-semibold", context.badgeClass)}>
          {context.badge}
        </span>
      </div>
      <div className="mt-2 text-foreground">{context.summary}</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", freshness.className)}>
          {freshness.label}
        </span>
        {warningCount > 0 && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-warning/10 text-warning">
            {warningCount} data note{warningCount > 1 ? "s" : ""}
          </span>
        )}
        {candidate.setups.slice(0, 2).map((setup) => (
          <span key={setup} className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-card-border/40 text-muted">
            {setup}
          </span>
        ))}
      </div>
      <a href={context.href} className="inline-flex mt-3 text-xs font-semibold text-accent hover:underline">
        Review source
      </a>
    </div>
  );
}

function ExecutionChecklist({
  candidate,
  depth,
  oi,
  liquidity,
  priceLocation,
  riskPlan,
}: {
  candidate: RadarCandidate;
  depth: ReturnType<typeof computeDepth>;
  oi: ReturnType<typeof computeOiContext>;
  liquidity: ReturnType<typeof computeLiquidityScore>;
  priceLocation: ReturnType<typeof computePriceLocation>;
  riskPlan: ReturnType<typeof computeRiskPlan>;
}) {
  const oiAligned =
    candidate.bias === "SHORT"
      ? oi.stance === "Bearish OI" || oi.stance === "No F&O Data"
      : candidate.bias === "LONG"
        ? oi.stance === "Bullish OI" || oi.stance === "No F&O Data"
        : false;
  const depthAligned =
    candidate.bias === "SHORT"
      ? depth.imbalance <= 0.05
      : candidate.bias === "LONG"
        ? depth.imbalance >= -0.05
        : false;
  const items = [
    {
      label: "Price location",
      value: priceLocation.label,
      tone: priceLocation.tone,
    },
    {
      label: "Spread rule",
      value: depth.spreadPct == null ? "Unknown" : depth.spreadPct <= 0.12 ? "Tradable" : "Too wide",
      tone: depth.spreadPct == null ? "warning" : depth.spreadPct <= 0.12 ? "profit" : "loss",
    },
    {
      label: "Liquidity",
      value: liquidity.score >= 75 ? "Clean" : liquidity.score >= 55 ? "Usable" : "Thin",
      tone: liquidity.tone,
    },
    {
      label: "Order book",
      value: depthAligned ? "Aligned" : "Not aligned",
      tone: depthAligned ? "profit" : "warning",
    },
    {
      label: "OI confirmation",
      value: oi.stance === "No F&O Data" ? "N/A" : oiAligned ? "Aligned" : "Conflicting",
      tone: oi.stance === "No F&O Data" ? "neutral" : oiAligned ? "profit" : "loss",
    },
    {
      label: "Risk size",
      value: riskPlan.quantity > 0 ? `${riskPlan.quantity} qty` : "No size",
      tone: riskPlan.quantity > 0 ? "profit" : "warning",
    },
  ] as const;

  return (
    <div className="bg-surface-hover rounded-lg p-3">
      <div className="text-xs font-semibold text-text-heading">Execution Checklist</div>
      <div className="text-xs text-muted mt-0.5">Use this before entering, especially on fast moves.</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
        {items.map((item) => (
          <div key={item.label} className="bg-card rounded p-2 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">{item.label}</span>
              <span className={cn("h-2 w-2 rounded-full shrink-0", toneBg(item.tone))} />
            </div>
            <div className={cn("font-mono text-xs font-semibold mt-1 truncate", toneText(item.tone))} title={item.value}>
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiquidityQualityCard({
  liquidity,
  depth,
}: {
  liquidity: ReturnType<typeof computeLiquidityScore>;
  depth: ReturnType<typeof computeDepth>;
}) {
  return (
    <div className="bg-surface-hover rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-text-heading">Liquidity Quality</div>
          <div className="text-xs text-muted mt-0.5">Spread, book depth, and RVOL before entry.</div>
        </div>
        <div className={cn("text-2xl font-bold font-mono", toneText(liquidity.tone))}>{liquidity.score}</div>
      </div>
      <div className="mt-3 h-2 rounded bg-card-border/30 overflow-hidden">
        <div className={cn("h-full", liquidity.tone === "profit" ? "bg-profit" : liquidity.tone === "warning" ? "bg-warning" : "bg-loss")} style={{ width: `${liquidity.score}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <MiniQuality label="Spread" value={depth.spreadPct == null ? "-" : `${depth.spreadPct.toFixed(2)}%`} tone={depth.spreadOk ? "profit" : "warning"} />
        <MiniQuality label="Bid Depth" value={formatQty(depth.bidQty)} tone={depth.bidQty >= depth.askQty ? "profit" : "neutral"} />
        <MiniQuality label="Ask Depth" value={formatQty(depth.askQty)} tone={depth.askQty > depth.bidQty ? "loss" : "neutral"} />
      </div>
      <div className="mt-3 space-y-1 text-xs">
        {liquidity.notes.map((note) => (
          <div key={note} className="text-muted">{note}</div>
        ))}
      </div>
    </div>
  );
}

function LiveTapeCard({
  spreadHistory,
  oiHistory,
  bias,
}: {
  spreadHistory: SpreadSnapshot[];
  oiHistory: OiSnapshot[];
  bias: Bias;
}) {
  const spreadTrend = trendLabel(spreadHistory.map((s) => s.spreadPct).filter((v): v is number => v != null));
  const oiTrend = computeOiTrend(oiHistory, bias);
  return (
    <div className="bg-surface-hover rounded-lg p-3">
      <div className="text-xs font-semibold text-text-heading">Live Confirmation Tape</div>
      <div className="text-xs text-muted mt-0.5">Refreshes every 15s while this card is open.</div>

      <div className="mt-4">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-muted">Spread History</span>
          <span className={toneText(spreadTrend.tone)}>{spreadTrend.label}</span>
        </div>
        <SparkBars values={spreadHistory.map((s) => s.spreadPct)} inverse />
      </div>

      <div className="mt-4">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-muted">OI Pressure</span>
          <span className={toneText(oiTrend.tone)}>{oiTrend.label}</span>
        </div>
        <SparkBars values={oiHistory.map((s) => Math.abs(s.callChange - s.putChange))} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <MiniQuality label="Samples" value={`${Math.max(spreadHistory.length, oiHistory.length)}/12`} tone="neutral" />
        <MiniQuality label="OI Delta" value={oiTrend.deltaText} tone={oiTrend.tone} />
      </div>
    </div>
  );
}

function RiskOrderPreview({
  candidate,
  riskCapital,
  onRiskCapitalChange,
  riskPlan,
  decisionLabel,
}: {
  candidate: RadarCandidate;
  riskCapital: number;
  onRiskCapitalChange: (value: number) => void;
  riskPlan: ReturnType<typeof computeRiskPlan>;
  decisionLabel: string;
}) {
  const side = candidate.bias === "SHORT" ? "SELL" : candidate.bias === "LONG" ? "BUY" : "WAIT";
  const canPreview = side !== "WAIT" && riskPlan.quantity > 0 && decisionLabel !== "AVOID FOR NOW";
  return (
    <div className="bg-surface-hover rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-text-heading">Risk & Broker Preview</div>
          <div className="text-xs text-muted mt-0.5">Dry run only. No order is sent.</div>
        </div>
        <span className={cn("px-2 py-1 rounded text-[10px] font-semibold", canPreview ? "bg-accent-bg text-accent" : "bg-card-border/40 text-muted")}>
          PREVIEW
        </span>
      </div>

      <label className="block mt-3 text-xs text-muted">
        Max risk per trade
        <input
          type="number"
          min={100}
          step={100}
          value={riskCapital}
          onChange={(event) => onRiskCapitalChange(Number(event.target.value) || 0)}
          className="mt-1 w-full bg-card border border-card-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
        />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <MiniQuality label="Side" value={side} tone={side === "BUY" ? "profit" : side === "SELL" ? "loss" : "neutral"} />
        <MiniQuality label="Qty" value={riskPlan.quantity > 0 ? String(riskPlan.quantity) : "-"} tone={riskPlan.quantity > 0 ? "profit" : "warning"} />
        <MiniQuality label="Risk/Share" value={riskPlan.riskPerShare > 0 ? riskPlan.riskPerShare.toFixed(2) : "-"} tone="neutral" />
        <MiniQuality label="Max Loss" value={riskPlan.maxLoss > 0 ? formatRupees(riskPlan.maxLoss) : "-"} tone="loss" />
      </div>

      <div className="mt-3 border border-card-border rounded overflow-hidden text-xs">
        <div className="grid grid-cols-2">
          <TicketCell label="Order" value={`${side} ${candidate.symbol}`} />
          <TicketCell label="Product" value="MIS / Intraday" />
          <TicketCell label="Limit" value={candidate.entry.toFixed(2)} />
          <TicketCell label="Stop" value={candidate.stop ? candidate.stop.toFixed(2) : "-"} />
          <TicketCell label="Target" value={candidate.target1 ? candidate.target1.toFixed(2) : "-"} />
          <TicketCell label="Est. Value" value={riskPlan.notional > 0 ? formatRupees(riskPlan.notional) : "-"} />
        </div>
      </div>

      <button
        type="button"
        disabled
        className="mt-3 w-full rounded bg-card-border/40 px-3 py-2 text-xs font-semibold text-muted cursor-not-allowed"
      >
        Broker execution disabled until order controls are added
      </button>
    </div>
  );
}

function MiniQuality({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: DecisionTone;
}) {
  return (
    <div className="bg-card rounded p-2 min-w-0">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={cn("font-mono font-semibold truncate", toneText(tone))} title={value}>{value}</div>
    </div>
  );
}

function TicketCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-r border-card-border p-2 min-w-0">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="font-mono font-semibold text-foreground truncate" title={value}>{value}</div>
    </div>
  );
}

function SparkBars({ values, inverse = false }: { values: Array<number | null>; inverse?: boolean }) {
  const valid = values.filter((v): v is number => v != null);
  const max = Math.max(...valid.map((v) => Math.abs(v)), 1);
  return (
    <div className="h-12 flex items-end gap-1 rounded bg-card p-2">
      {values.length === 0 && <div className="text-xs text-muted self-center">Waiting for samples...</div>}
      {values.map((value, index) => {
        const height = value == null ? 8 : Math.max(8, (Math.abs(value) / max) * 32);
        const isGood = inverse ? value != null && value <= 0.12 : index === values.length - 1;
        return (
          <div
            key={`${value ?? "x"}-${index}`}
            className={cn("w-full rounded-sm", value == null ? "bg-card-border/30" : isGood ? "bg-profit" : "bg-accent")}
            style={{ height }}
            title={value == null ? "No value" : value.toFixed(2)}
          />
        );
      })}
    </div>
  );
}

export function appendSnapshot<T>(items: T[], item: T, maxItems: number): T[] {
  return [...items, item].slice(-maxItems);
}

function toneText(tone: DecisionTone): string {
  return tone === "profit" ? "text-profit" :
    tone === "loss" ? "text-loss" :
    tone === "warning" ? "text-warning" :
    "text-foreground";
}

function AlertRuleCard({
  candidate,
  saved,
  syncState,
  onSave,
}: {
  candidate: RadarCandidate;
  saved: boolean;
  syncState: AlertSyncState;
  onSave: () => void;
}) {
  const canSave = candidate.symbol && candidate.bias !== "NEUTRAL" && candidate.entry > 0;
  const statusLabel =
    syncState === "saving" ? "SYNCING" :
      syncState === "synced" ? "SERVER" :
        saved ? "LOCAL" :
          syncState === "error" ? "ERROR" :
            "LOCAL";
  const statusClass =
    syncState === "synced" ? "bg-profit-bg text-profit" :
      syncState === "saving" ? "bg-warning/10 text-warning" :
        syncState === "error" ? "bg-loss-bg text-loss" :
          saved ? "bg-card-border/50 text-foreground" :
            "bg-card-border/40 text-muted";
  const helperText =
    syncState === "synced" ? "Synced to your account; local fallback is also kept." :
      syncState === "saving" ? "Saving locally first, then syncing to your account." :
        saved ? "Saved locally if backend auth or session sync is unavailable." :
          "Save a cockpit trigger for later review and alerting.";
  return (
    <div className="bg-surface-hover rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-text-heading">Alert Rule</div>
          <div className="text-xs text-muted mt-0.5">{helperText}</div>
        </div>
        <span className={cn("px-2 py-1 rounded text-[10px] font-semibold", statusClass)}>
          {statusLabel}
        </span>
      </div>

      <div className="mt-3 space-y-2 text-xs">
        <MiniQuality label="Trigger" value={candidate.entry > 0 ? `${candidate.bias} near ${candidate.entry.toFixed(2)}` : "No trigger"} tone={canSave ? "profit" : "warning"} />
        <MiniQuality label="Quality" value={`Score >= ${Math.max(70, candidate.score)}`} tone={candidate.score >= 70 ? "profit" : "warning"} />
        <MiniQuality label="Execution" value="Spread <= 0.12%" tone="neutral" />
        <MiniQuality label="Risk" value={candidate.stop ? `Stop ${candidate.stop.toFixed(2)}` : "Manual stop"} tone={candidate.stop ? "profit" : "warning"} />
      </div>

      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        className={cn(
          "mt-3 w-full rounded px-3 py-2 text-xs font-semibold",
          canSave ? "bg-accent text-white hover:bg-accent/80" : "bg-card-border/40 text-muted cursor-not-allowed",
        )}
      >
        {syncState === "saving" ? "Saving..." : saved ? "Update Alert Rule" : "Save Alert Rule"}
      </button>
    </div>
  );
}

function toneBg(tone: DecisionTone): string {
  return tone === "profit" ? "bg-profit" :
    tone === "loss" ? "bg-loss" :
    tone === "warning" ? "bg-warning" :
    "bg-muted";
}

function sourceContext(candidate: RadarCandidate) {
  const setups = candidate.setups.join(" ").toUpperCase();
  const warnings = candidate.dataWarnings.join(" ").toUpperCase();
  if (setups.includes("ABNORMAL") || warnings.includes("ABNORMAL")) {
    return {
      label: "Abnormal Moves",
      badge: "SURVEILLANCE",
      badgeClass: "bg-warning/10 text-warning",
      href: "/trade-ideas?tab=abnormal",
      summary: "This setup started as abnormal price-volume surveillance. Confirm news, liquidity, and invalidation before sizing.",
    };
  }
  if (
    setups.includes("SWING") ||
    setups.includes("10D_BO") ||
    setups.includes("50D_BO") ||
    setups.includes("LIQUIDITY_SHOCK") ||
    setups.includes("VOL_SQUEEZE") ||
    setups.includes("RS_PULLBACK") ||
    setups.includes("MOMENTUM_BURST") ||
    setups.includes("CHANNEL_BO") ||
    setups.includes("REVERSAL") ||
    warnings.includes("SWING")
  ) {
    return {
      label: "Swing Spectrum",
      badge: "SWING",
      badgeClass: "bg-accent-bg text-accent",
      href: "/trade-ideas?tab=swing",
      summary: "This setup was adapted from the swing scanner. Treat intraday depth as confirmation, not the original thesis.",
    };
  }
  if (candidate.quality === "DATA_CHECK" || warnings.length > 0) {
    return {
      label: "Manual Review",
      badge: "CHECK",
      badgeClass: "bg-loss-bg text-loss",
      href: "/pulse",
      summary: "This symbol needs manual confirmation because the source data or active setup is incomplete.",
    };
  }
  return {
    label: "Intraday Radar",
    badge: "LIVE",
    badgeClass: "bg-profit-bg text-profit",
    href: "/pulse",
    summary: "This setup came from the live intraday Radar ranking. Use spread, OI, and risk checks before entry.",
  };
}

function freshnessLabel(freshness: RadarCandidate["freshness"]) {
  if (freshness.status === "fresh") {
    return { label: "fresh", className: "bg-profit-bg text-profit" };
  }
  if (freshness.status === "stale") {
    const age = freshness.ageSeconds == null ? "" : ` ${Math.round(freshness.ageSeconds)}s`;
    return { label: `stale${age}`, className: "bg-warning/10 text-warning" };
  }
  return { label: "freshness unknown", className: "bg-card-border/40 text-muted" };
}

function snapshotAgeLabel(ageSeconds?: number | null) {
  if (ageSeconds == null) return "warming";
  if (ageSeconds < 60) return `${Math.max(0, Math.round(ageSeconds))}s ago`;
  return `${Math.floor(ageSeconds / 60)}m ago`;
}

function computePriceLocation(candidate: RadarCandidate) {
  if (!candidate.entry || !candidate.ltp) {
    return { label: "Unknown", tone: "warning" as DecisionTone, distancePct: null as number | null };
  }

  const signedDistancePct =
    candidate.bias === "SHORT"
      ? ((candidate.entry - candidate.ltp) / candidate.entry) * 100
      : ((candidate.ltp - candidate.entry) / candidate.entry) * 100;
  const absDistance = Math.abs(signedDistancePct);

  if (signedDistancePct < -0.25) {
    return {
      label: `${absDistance.toFixed(2)}% before trigger`,
      tone: "warning" as DecisionTone,
      distancePct: signedDistancePct,
    };
  }
  if (signedDistancePct <= 0.45) {
    return {
      label: `${absDistance.toFixed(2)}% from entry`,
      tone: "profit" as DecisionTone,
      distancePct: signedDistancePct,
    };
  }
  if (signedDistancePct <= 0.9) {
    return {
      label: `${signedDistancePct.toFixed(2)}% extended`,
      tone: "warning" as DecisionTone,
      distancePct: signedDistancePct,
    };
  }
  return {
    label: `${signedDistancePct.toFixed(2)}% chase risk`,
    tone: "loss" as DecisionTone,
    distancePct: signedDistancePct,
  };
}

function computeLiquidityScore(candidate: RadarCandidate, depth: ReturnType<typeof computeDepth>) {
  let score = 50;
  const notes: string[] = [];

  if (depth.spreadPct == null) {
    score -= 15;
    notes.push("Spread unavailable: treat execution quality as unconfirmed.");
  } else if (depth.spreadPct <= 0.05) {
    score += 20;
    notes.push("Spread is tight enough for aggressive intraday execution.");
  } else if (depth.spreadPct <= 0.12) {
    score += 8;
    notes.push("Spread is acceptable, but avoid chasing.");
  } else {
    score -= 20;
    notes.push("Spread is wide: use smaller size or skip.");
  }

  const visibleDepth = depth.bidQty + depth.askQty;
  if (visibleDepth >= 100000) {
    score += 15;
    notes.push("Visible Arrow depth is strong.");
  } else if (visibleDepth >= 25000) {
    score += 6;
    notes.push("Visible Arrow depth is usable.");
  } else {
    score -= 12;
    notes.push("Visible Arrow depth is thin.");
  }

  if (candidate.volRatio >= 1.5) {
    score += 15;
    notes.push("RVOL confirms active participation.");
  } else if (candidate.volRatio >= 1) {
    score += 5;
    notes.push("RVOL is acceptable.");
  } else {
    score -= 10;
    notes.push("RVOL is weak for blind execution.");
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tone: DecisionTone = clamped >= 75 ? "profit" : clamped >= 55 ? "warning" : "loss";
  return { score: clamped, tone, notes };
}

function computeRiskPlan(candidate: RadarCandidate, riskCapital: number, lotSize: number | null) {
  const riskPerShare = candidate.stop ? Math.abs(candidate.entry - candidate.stop) : 0;
  const rawQuantity = riskPerShare > 0 ? Math.floor(riskCapital / riskPerShare) : 0;
  const quantity = lotSize && lotSize > 0 ? Math.floor(rawQuantity / lotSize) * lotSize : rawQuantity;
  const maxLoss = quantity * riskPerShare;
  const notional = quantity * candidate.entry;
  return {
    riskPerShare,
    quantity: Math.max(0, quantity),
    lots: lotSize && lotSize > 0 ? Math.floor(quantity / lotSize) : null,
    maxLoss,
    notional,
  };
}

function trendLabel(values: number[]) {
  if (values.length < 2) return { label: "Collecting", tone: "neutral" as DecisionTone };
  const first = values[0];
  const last = values[values.length - 1];
  if (last < first * 0.85) return { label: "Improving", tone: "profit" as DecisionTone };
  if (last > first * 1.15) return { label: "Worsening", tone: "loss" as DecisionTone };
  return { label: "Stable", tone: "neutral" as DecisionTone };
}

function computeOiTrend(history: OiSnapshot[], bias: Bias) {
  if (history.length < 2) {
    return { label: "Collecting", tone: "neutral" as DecisionTone, deltaText: "-" };
  }
  const first = history[0];
  const last = history[history.length - 1];
  const callDelta = last.callChange - first.callChange;
  const putDelta = last.putChange - first.putChange;
  const pressureDelta = bias === "SHORT" ? callDelta - putDelta : putDelta - callDelta;
  const tone: DecisionTone = pressureDelta > 0 ? "profit" : pressureDelta < 0 ? "loss" : "neutral";
  const label =
    pressureDelta > 0 ? `${bias === "SHORT" ? "Call" : "Put"} buildup confirming` :
    pressureDelta < 0 ? "OI not confirming" :
    "Flat";
  return { label, tone, deltaText: formatQty(Math.abs(pressureDelta)) };
}

export function computeDepth(quote: ArrowFullQuote | null) {
  const bestBid = quote?.depth?.buy?.[0] || null;
  const bestAsk = quote?.depth?.sell?.[0] || null;
  const bidQty = (quote?.depth?.buy || []).slice(0, 5).reduce((sum, level) => sum + (level.quantity || 0), 0);
  const askQty = (quote?.depth?.sell || []).slice(0, 5).reduce((sum, level) => sum + (level.quantity || 0), 0);
  const mid = bestBid?.price && bestAsk?.price ? (bestBid.price + bestAsk.price) / 2 : quote?.last_price || 0;
  const spread = bestBid?.price && bestAsk?.price ? bestAsk.price - bestBid.price : null;
  const spreadPct = spread != null && mid > 0 ? (spread / mid) * 100 : null;
  const imbalance = bidQty + askQty > 0 ? (bidQty - askQty) / (bidQty + askQty) : 0;
  const biasLabel =
    imbalance > 0.2 ? "Bid Heavy" :
    imbalance < -0.2 ? "Ask Heavy" :
    "Balanced";
  const depthTone: DecisionTone = imbalance > 0.2 ? "profit" : imbalance < -0.2 ? "loss" : "neutral";
  return {
    bestBid,
    bestAsk,
    bidQty,
    askQty,
    imbalance,
    biasLabel,
    depthTone,
    spreadPct,
    spreadOk: spreadPct != null && spreadPct <= 0.12,
  };
}

export function computeOiContext(chain: FnoChainResponse | null) {
  if (!chain) {
    return {
      pcr: null,
      pcrTone: "neutral" as const,
      stance: "No F&O Data",
      stanceTone: "neutral" as const,
      totalCallOI: null,
      totalPutOI: null,
      callChange: 0,
      putChange: 0,
    };
  }
  const pcr = chain.analytics.pcr;
  const callChange = chain.chain.reduce((sum, row) => sum + (row.call?.oiChange || 0), 0);
  const putChange = chain.chain.reduce((sum, row) => sum + (row.put?.oiChange || 0), 0);
  const stance =
    pcr < 0.85 && callChange > putChange ? "Bearish OI" :
    pcr > 1.15 && putChange > callChange ? "Bullish OI" :
    "Mixed OI";
  const stanceTone: DecisionTone = stance === "Bearish OI" ? "loss" : stance === "Bullish OI" ? "profit" : "warning";
  const pcrTone: DecisionTone = pcr < 0.85 ? "loss" : pcr > 1.15 ? "profit" : "warning";
  return {
    pcr,
    pcrTone,
    stance,
    stanceTone,
    totalCallOI: chain.analytics.totalCallOI,
    totalPutOI: chain.analytics.totalPutOI,
    callChange,
    putChange,
  };
}

function computeTradeDecision(
  candidate: RadarCandidate,
  depth: ReturnType<typeof computeDepth>,
  oi: ReturnType<typeof computeOiContext>,
  detail: TradeDetailState,
  liquidity: ReturnType<typeof computeLiquidityScore>,
  priceLocation: ReturnType<typeof computePriceLocation>,
) {
  let score = candidate.score;
  const reasons: string[] = [];

  if (candidate.action === "ACTIONABLE") {
    score += 8;
    reasons.push("Radar marks this setup actionable.");
  } else {
    score -= 12;
    reasons.push("Radar still wants confirmation before action.");
  }

  if (candidate.quality === "A_PLUS" || candidate.quality === "A") {
    score += 8;
    reasons.push(`Signal quality is ${qualityLabel(candidate.quality)}.`);
  } else if (candidate.quality === "DATA_CHECK") {
    score -= 20;
    reasons.push("Data check warning is present.");
  }

  if (candidate.volRatio >= 1.2) {
    score += 6;
    reasons.push(`Volume is active at ${candidate.volRatio.toFixed(1)}x RVOL.`);
  } else {
    score -= 8;
    reasons.push(`Low RVOL (${candidate.volRatio.toFixed(1)}x) reduces conviction.`);
  }

  if (depth.spreadPct == null) {
    score -= 6;
    reasons.push("Arrow bid/ask spread is unavailable.");
  } else if (depth.spreadOk) {
    score += 7;
    reasons.push(`Spread is tradable at ${depth.spreadPct.toFixed(2)}%.`);
  } else {
    score -= 12;
    reasons.push(`Spread is wide at ${depth.spreadPct.toFixed(2)}%.`);
  }

  if (liquidity.score >= 75) {
    score += 5;
    reasons.push(`Liquidity quality is clean at ${liquidity.score}/100.`);
  } else if (liquidity.score < 55) {
    score -= 10;
    reasons.push(`Liquidity quality is weak at ${liquidity.score}/100.`);
  }

  if (priceLocation.tone === "profit") {
    score += 6;
    reasons.push(`Price is still executable: ${priceLocation.label}.`);
  } else if (priceLocation.tone === "warning") {
    score -= 4;
    reasons.push(`Price location needs patience: ${priceLocation.label}.`);
  } else {
    score -= 14;
    reasons.push(`Price is extended from entry: ${priceLocation.label}.`);
  }

  const depthSupportsShort = candidate.bias === "SHORT" && depth.imbalance < -0.15;
  const depthSupportsLong = candidate.bias === "LONG" && depth.imbalance > 0.15;
  if (depthSupportsShort || depthSupportsLong) {
    score += 7;
    reasons.push(`Order book supports ${candidate.bias.toLowerCase()} side (${depth.biasLabel}).`);
  } else if (depth.biasLabel !== "Balanced") {
    score -= 4;
    reasons.push(`Order book is ${depth.biasLabel}, not aligned with ${candidate.bias.toLowerCase()} bias.`);
  }

  const oiSupportsShort = candidate.bias === "SHORT" && oi.stance === "Bearish OI";
  const oiSupportsLong = candidate.bias === "LONG" && oi.stance === "Bullish OI";
  if (oiSupportsShort || oiSupportsLong) {
    score += 8;
    reasons.push(`F&O OI confirms ${candidate.bias.toLowerCase()} positioning.`);
  } else if (oi.stance === "Mixed OI") {
    score -= 3;
    reasons.push("F&O OI is mixed, so size should stay conservative.");
  } else if (oi.stance !== "No F&O Data") {
    score -= 8;
    reasons.push(`F&O OI conflicts with Radar: ${oi.stance}.`);
  } else {
    score -= 4;
    reasons.push("No stock OI context available for confirmation.");
  }

  if (detail.error) {
    score -= 4;
    reasons.push("Some context feed is unavailable, so conviction is reduced.");
  }

  const blockers = executionBlockers({
    researchOnly: !!candidate.researchOnly,
    marketOpen: isMarketOpen(),
    freshness: candidate.freshness.status,
    ageSeconds: candidate.freshness.ageSeconds,
    spreadPct: depth.spreadPct,
    liquidityScore: liquidity.score,
    entry: candidate.entry,
    stop: candidate.stop,
    bias: candidate.bias,
    quotePrice: detail.quote?.last_price ?? null,
    quoteReceivedAt: detail.spreadHistory.at(-1)?.ts ?? null,
    now: Date.now(),
    feedError: !!detail.error,
  });
  reasons.unshift(...blockers);
  const label =
    blockers.length ? "PLANNING ONLY" :
    score >= 82 ? "TAKE ONLY ON TRIGGER" :
    score >= 65 ? "WAIT FOR CONFIRMATION" :
    "AVOID FOR NOW";
  const summary =
    label === "PLANNING ONLY"
      ? "Research remains available. Mandatory execution checks are incomplete; a ranking score cannot override them."
      : label === "TAKE ONLY ON TRIGGER"
      ? "The setup has enough alignment, but execute only near entry with stop intact."
      : label === "WAIT FOR CONFIRMATION"
        ? "There is a trade idea here, but order-flow/OI confirmation is not strong enough yet."
        : "The setup lacks enough confirmation or execution quality right now.";
  const toneClass =
    label === "TAKE ONLY ON TRIGGER" ? "text-profit bg-profit-bg" :
    label === "WAIT FOR CONFIRMATION" || label === "PLANNING ONLY" ? "text-warning bg-[rgba(255,193,7,0.1)]" :
    "text-loss bg-loss-bg";
  const panelClass =
    label === "TAKE ONLY ON TRIGGER" ? "border-card-border bg-profit-bg/50 text-profit" :
    label === "WAIT FOR CONFIRMATION" || label === "PLANNING ONLY" ? "border-card-border bg-[rgba(255,193,7,0.08)] text-warning" :
    "border-card-border bg-loss-bg/60 text-loss";

  return { label, summary, reasons, toneClass, panelClass };
}

function oiClockAnalytics(chain: FnoChainResponse) {
  const resistance = [...chain.chain]
    .filter((s) => s.call && s.call.oi > 0)
    .sort((a, b) => (b.call!.oi || 0) - (a.call!.oi || 0))
    .slice(0, 3)
    .map((s) => s.strike);
  const support = [...chain.chain]
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
    resistance,
    support,
  };
}

function strikeStep(chain: ChainStrike[]): number {
  if (chain.length < 2) return 50;
  const sorted = [...chain].sort((a, b) => a.strike - b.strike);
  return sorted[1].strike - sorted[0].strike || 50;
}

function formatQty(v: number): string {
  if (Math.abs(v) >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (Math.abs(v) >= 100000) return `${(v / 100000).toFixed(1)}L`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

function formatRupees(v: number): string {
  if (Math.abs(v) >= 10000000) return `Rs ${(v / 10000000).toFixed(2)}Cr`;
  if (Math.abs(v) >= 100000) return `Rs ${(v / 100000).toFixed(2)}L`;
  return `Rs ${Math.round(v).toLocaleString("en-IN")}`;
}

function TradeMetric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="bg-surface-hover rounded p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cn("font-mono font-semibold mt-1", emphasis ? "text-2xl text-accent" : "text-base text-text-heading")}>
        {value}
      </div>
    </div>
  );
}

function CandidatePanel({
  title,
  candidates,
  onInspect,
  tone = "neutral",
}: {
  title: string;
  candidates: RadarCandidate[];
  onInspect: (candidate: RadarCandidate) => void;
  tone?: "bull" | "bear" | "neutral";
}) {
  const isBull = tone === "bull";
  const isBear = tone === "bear";

  return (
    <div className={cn(
      "overflow-hidden rounded-xl border bg-card shadow-sm",
      "border-card-border"
    )}>
      <div className={cn(
        "border-b px-4 py-3",
        isBull ? "border-card-border bg-profit-bg" : isBear ? "border-card-border bg-loss-bg" : "border-card-border"
      )}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-black uppercase tracking-wide text-text-heading">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {isBull ? "Long candidates ranked by confirmation and volume." : isBear ? "Short candidates ranked by breakdown and weakness." : "Ranked candidates."}
            </p>
          </div>
          <span className={cn(
            "rounded-full px-2.5 py-1 text-xs font-black",
            isBull ? "bg-profit text-white" : isBear ? "bg-loss text-white" : "bg-surface-hover text-muted"
          )}>
            {candidates.length}
          </span>
        </div>
      </div>
      <div className="max-h-[520px] divide-y divide-card-border/40 overflow-auto">
        {candidates.map((candidate) => (
          <CandidateButton key={candidate.symbol} candidate={candidate} onInspect={onInspect} />
        ))}
        {candidates.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted">
            No clean {isBull ? "bullish" : isBear ? "bearish" : ""} setups yet.
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateButton({
  candidate,
  onInspect,
}: {
  candidate: RadarCandidate;
  onInspect: (candidate: RadarCandidate) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onInspect(candidate)}
      className="block w-full px-4 py-3 text-left transition-colors hover:bg-hover-bg"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-black text-text-heading">{candidate.symbol}</span>
            <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", biasClass(candidate.bias))}>
              {candidate.bias}
            </span>
            <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", qualityClass(candidate.quality))}>
              {qualityLabel(candidate.quality)}
            </span>
          </div>
          <div className="mt-1 line-clamp-1 text-xs text-muted">
            {candidate.reasons[0] || candidate.setups.map(setupLabel).join(", ")}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn("text-xl font-black", scoreClass(candidate.score, candidate.bias))}>
            {candidate.score}
          </div>
          <div className={cn("text-xs", candidate.changePct >= 0 ? "text-profit" : "text-loss")}>
            {candidate.changePct > 0 ? "+" : ""}{candidate.changePct.toFixed(2)}%
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
        <MiniStat label="RVOL" value={`${candidate.volRatio.toFixed(1)}x`} />
        <MiniStat label="R" value={candidate.rFactor.toFixed(1)} />
        <MiniStat label="Entry" value={candidate.entry.toFixed(2)} />
        <MiniStat label="Volume" value={formatVol(candidate.volume)} />
      </div>
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="font-mono text-foreground">{value}</div>
    </div>
  );
}
