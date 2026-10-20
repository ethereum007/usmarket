"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ChevronDown,
  Search,
  Star,
} from "lucide-react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
} from "recharts";
import { fetchAPI } from "../../lib/api";
import { cn, formatNumber, isMarketOpen } from "../../lib/utils";
import { useAuth } from "../../contexts/AuthContext";
import { PremiumLocked } from "../premium/PremiumBadge";
import type { RadarCandidate } from "./PulseContent";

type SetupFilter = "all" | "intraday" | "swing" | "positional";
type BiasFilter = "all" | "BULLISH" | "BEARISH" | "NEUTRAL";
type RiskFilter = "all" | "LOW" | "MEDIUM" | "HIGH";

interface Signal {
  symbol: string;
  category: "index" | "stock";
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: "STRONG" | "MODERATE" | "WEAK";
  score: number;
  recommendation: any;
  cashRecommendation?: any;
  cash_recommendation?: any;
  analytics: any;
  scoreBreakdown: any;
  score_breakdown?: any;
  spot?: number;
  pcr?: number;
  max_pain_strike?: number;
  expiry?: string;
  reasons: string[];
}

interface PreScreened {
  symbol: string;
  spot: number;
  futPrice: number;
  changePct: number;
  oi: number;
  oiChange: number;
  volume: number;
  preScore: number;
  preDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
  preReasons: string[];
}

interface SignalResponse {
  success: boolean;
  signals: Signal[];
  preScreened?: PreScreened[];
  summary: {
    bullish: number;
    bearish: number;
    neutral: number;
    strongSignals: number;
    total: number;
  };
  preScreenSummary?: {
    total: number;
    bullish: number;
    bearish: number;
    deepAnalyzed: number;
  };
  timestamp: number;
}

type QueueRow = {
  key: string;
  rank: number;
  signal: Signal;
  symbol: string;
  bias: Signal["direction"];
  setup: SetupFilter;
  confidence: number;
  confidenceLabel: Signal["confidence"];
  price: number;
  changePct: number;
  oiChangePct: number;
  oiChangeValue: number;
  volumeSurge: number;
  trigger: string;
  risk: Exclude<RiskFilter, "all">;
  status: "ACTIVE" | "WATCH";
  sector: string;
};

type SectorBreadth = {
  name: string;
  change: number;
  leaders: string[];
};

const REFRESH_INTERVAL = 60;
const PREMIUM_MODERATE_SCORE = 35;
const RADAR_CANDIDATE_STORAGE_KEY = "alpha-radar:selected-candidate";

const SECTOR_MAP: Record<string, string> = {
  RELIANCE: "Oil & Gas",
  HDFCBANK: "Private Bank",
  ICICIBANK: "Private Bank",
  AXISBANK: "Private Bank",
  SBIN: "PSU Bank",
  TCS: "IT Services",
  INFY: "IT Services",
  WIPRO: "IT Services",
  HCLTECH: "IT Services",
  TECHM: "IT Services",
  LT: "Capital Goods",
  MARUTI: "Automobile",
  TATAMOTORS: "Automobile",
  TATASTEEL: "Metals",
  JSWSTEEL: "Metals",
  SUNPHARMA: "Pharma",
  DIVISLAB: "Pharma",
  ICICIGI: "Insurance",
  BATAINDIA: "Consumer",
  KPRMILL: "Textiles",
  NETWEB: "Technology",
  CARTRADE: "Consumer Internet",
};

function formatOI(val: number): string {
  if (!Number.isFinite(val)) return "—";
  if (Math.abs(val) >= 10000000) return `${(val / 10000000).toFixed(1)}Cr`;
  if (Math.abs(val) >= 100000) return `${(val / 100000).toFixed(1)}L`;
  if (Math.abs(val) >= 1000) return `${(val / 1000).toFixed(1)}K`;
  return String(Math.round(val));
}

function pick<T>(a: T | undefined, b: T | undefined): T | undefined {
  return a !== undefined ? a : b;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function signalKey(signal: Signal) {
  return `${signal.symbol}-${signal.category}`;
}

function isPremiumSignal(signal: Signal): boolean {
  if (signal.confidence === "STRONG") return true;
  return signal.confidence === "MODERATE" && Math.abs(signal.score) >= PREMIUM_MODERATE_SCORE;
}

function signalSpot(signal: Signal) {
  return signal.spot ?? signal.analytics?.spot ?? signal.analytics?.ltp ?? signal.analytics?.last ?? 0;
}

function signalPcr(signal: Signal) {
  return signal.pcr ?? signal.analytics?.pcr ?? signal.analytics?.putCallRatio ?? signal.analytics?.put_call_ratio ?? 0;
}

function signalMaxPain(signal: Signal) {
  return signal.max_pain_strike ?? signal.analytics?.maxPainStrike ?? signal.analytics?.max_pain_strike ?? 0;
}

function signalChangePct(signal: Signal) {
  return Number(signal.analytics?.changePct ?? signal.analytics?.change_pct ?? signal.analytics?.chgPct ?? 0);
}

function signalCash(signal: Signal) {
  return pick(signal.cashRecommendation, signal.cash_recommendation) ?? null;
}

function signalStopLoss(value: any) {
  return value ? (value.stopLoss ?? value.stop_loss ?? null) : null;
}

function sectorFor(symbol: string, category: Signal["category"]) {
  if (category === "index") return "Index Options";
  return SECTOR_MAP[symbol] ?? "F&O Stock";
}

function deriveVolumeSurge(signal: Signal) {
  const direct =
    signal.analytics?.volumeRatio ??
    signal.analytics?.volume_ratio ??
    signal.analytics?.volRatio ??
    signal.scoreBreakdown?.volumeRatio ??
    signal.score_breakdown?.volumeRatio;
  if (Number.isFinite(Number(direct)) && Number(direct) > 0) return Number(direct);
  return Number.NaN;
}

function deriveOiChangePct(signal: Signal) {
  const direct =
    signal.analytics?.oiChangePct ??
    signal.analytics?.oi_change_pct ??
    signal.analytics?.oiChangePercent ??
    signal.scoreBreakdown?.oiChangePct ??
    signal.score_breakdown?.oiChangePct;
  if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
  return Number.NaN;
}

function deriveOiChangeValue(signal: Signal) {
  const direct =
    signal.analytics?.oiChange ??
    signal.analytics?.oi_change ??
    signal.analytics?.openInterestChange ??
    signal.recommendation?.oiChange ??
    signal.recommendation?.oi_change;
  if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
  return Number.NaN;
}

function deriveRisk(signal: Signal, volumeSurge: number): Exclude<RiskFilter, "all"> {
  if (!Number.isFinite(volumeSurge)) return "HIGH";
  const absScore = Math.abs(signal.score || 0);
  const pcr = signalPcr(signal);
  if (signal.confidence === "WEAK" || absScore < 50 || volumeSurge < 1.2) return "HIGH";
  if ((signal.direction === "BULLISH" && pcr < 0.7) || (signal.direction === "BEARISH" && pcr > 1.3)) return "HIGH";
  if (absScore >= 75 && volumeSurge >= 2) return "LOW";
  return "MEDIUM";
}

function deriveSetup(signal: Signal, volumeSurge: number): SetupFilter {
  if (signal.category === "index") return "intraday";
  if (volumeSurge >= 2.6 || signal.reasons?.some((reason) => /break|volume|vwap/i.test(reason))) return "intraday";
  if (Math.abs(signal.score) >= 70 || signal.reasons?.some((reason) => /52|swing|delivery/i.test(reason))) return "swing";
  return "positional";
}

function deriveTrigger(signal: Signal, volumeSurge: number) {
  const reasons = signal.reasons || [];
  const joined = reasons.join(" ").toLowerCase();
  if (joined.includes("pdh")) return "PDH Breakout";
  if (joined.includes("pdl")) return "PDL Breakdown";
  if (joined.includes("vwap")) return signal.direction === "BEARISH" ? "VWAP Reject" : "VWAP Reclaim";
  if (joined.includes("cpr")) return "CPR Bounce";
  if (joined.includes("52")) return "52W High Break";
  if (volumeSurge >= 2.5) return "Volume Breakout";
  if (signal.direction === "BULLISH") return "Range Breakout";
  if (signal.direction === "BEARISH") return "Resistance Test";
  return "Consolidation";
}

function buildQueueRow(signal: Signal, rank: number): QueueRow {
  const volumeSurge = deriveVolumeSurge(signal);
  const risk = deriveRisk(signal, volumeSurge);
  const confidence = clamp(Math.round(Math.abs(signal.score || 0)), 0, 100);
  return {
    key: signalKey(signal),
    rank,
    signal,
    symbol: signal.symbol,
    bias: signal.direction,
    setup: deriveSetup(signal, volumeSurge),
    confidence,
    confidenceLabel: signal.confidence,
    price: signalSpot(signal),
    changePct: signalChangePct(signal),
    oiChangePct: deriveOiChangePct(signal),
    oiChangeValue: deriveOiChangeValue(signal),
    volumeSurge,
    trigger: deriveTrigger(signal, volumeSurge),
    risk,
    status: confidence >= 72 && risk !== "HIGH" ? "ACTIVE" : "WATCH",
    sector: sectorFor(signal.symbol, signal.category),
  };
}

function toSignalRadarCandidate(signal: Signal): RadarCandidate {
  const cash = signalCash(signal);
  const spot = signalSpot(signal);
  const bias = signal.direction === "BULLISH" ? "LONG" : signal.direction === "BEARISH" ? "SHORT" : "NEUTRAL";
  const entry = cash?.entry || spot || 0;
  const stop = signalStopLoss(cash);
  const target = cash?.target1 || null;
  const risk = stop && entry ? Math.abs(entry - stop) : 0;
  const reward = target && entry ? Math.abs(target - entry) : 0;
  const rr = risk > 0 ? reward / risk : null;
  const volumeRatio = deriveVolumeSurge(signal);

  return {
    symbol: signal.symbol,
    bias,
    score: Math.round(Math.abs(signal.score || 0)),
    quality: signal.confidence === "STRONG" ? "A" : signal.confidence === "MODERATE" ? "B" : "WATCH",
    action: bias === "NEUTRAL" ? "WAIT" : signal.confidence === "STRONG" ? "CONFIRM" : "WAIT",
    setups: ["OI_SIGNAL", signal.direction, signal.confidence],
    entry,
    stop,
    target1: target,
    target2: cash?.target2 || null,
    riskReward: rr,
    invalidation: stop ? `${bias} signal invalidates beyond ${formatNumber(stop)}.` : "No valid signal stop available.",
    ltp: spot,
    changePct: signalChangePct(signal),
    volume: signal.recommendation?.volume || 0,
    volRatio: Number.isFinite(volumeRatio) ? volumeRatio : 0,
    rFactor: rr || 0,
    vwap: null,
    pdh: null,
    pdl: null,
    sector: signal.category === "index" ? "Index OI Signal" : "Stock OI Signal",
    freshness: { status: "unknown", ageSeconds: null },
    dataWarnings: ["Options signal adapted into the standalone decision cockpit. Verify quote freshness.", ...(!Number.isFinite(volumeRatio) ? ["Relative volume is unavailable for this signal."] : [])],
    reasons: signal.reasons || [],
  };
}

function biasClasses(bias: Signal["direction"]) {
  if (bias === "BULLISH") return "border-emerald-400/20 bg-emerald-400/10 text-profit";
  if (bias === "BEARISH") return "border-rose-400/20 bg-rose-400/10 text-loss";
  return "border-slate-500/30 bg-slate-500/10 text-foreground";
}

function riskClasses(risk: QueueRow["risk"]) {
  if (risk === "LOW") return "border-emerald-400/20 bg-emerald-400/10 text-profit";
  if (risk === "MEDIUM") return "border-amber-400/25 bg-amber-400/10 text-warning";
  return "border-rose-400/25 bg-rose-400/10 text-loss";
}

function statusClasses(status: QueueRow["status"]) {
  return status === "ACTIVE"
    ? "border-emerald-400/20 bg-emerald-400/10 text-profit"
    : "border-amber-400/25 bg-amber-400/10 text-warning";
}

function textTone(value: number) {
  if (value > 0) return "text-profit";
  if (value < 0) return "text-loss";
  return "text-muted";
}

function buildSectorBreadth(rows: QueueRow[]): SectorBreadth[] {
  const grouped = new Map<string, QueueRow[]>();
  rows.forEach((row) => {
    const bucket = grouped.get(row.sector) ?? [];
    bucket.push(row);
    grouped.set(row.sector, bucket);
  });
  return Array.from(grouped.entries())
    .map(([name, values]) => ({
      name,
      change: values.reduce((sum, row) => sum + row.changePct, 0) / Math.max(values.length, 1),
      leaders: values.slice(0, 3).map((row) => row.symbol),
    }))
    .sort((a, b) => b.change - a.change)
    .slice(0, 6);
}

function lastUpdatedLabel(timestamp?: number) {
  if (!timestamp) return "Waiting for data";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Live refresh";
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function SignalsContent() {
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;
  const [setupFilter, setSetupFilter] = useState<SetupFilter>("all");
  const [biasFilter, setBiasFilter] = useState<BiasFilter>("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [minConfidence, setMinConfidence] = useState(0);
  const [search, setSearch] = useState("");
  const [data, setData] = useState<SignalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [selectedSignalKey, setSelectedSignalKey] = useState<string | null>(null);

  const openSignalDecision = useCallback((signal: Signal) => {
    window.sessionStorage.setItem(RADAR_CANDIDATE_STORAGE_KEY, JSON.stringify(toSignalRadarCandidate(signal)));
    window.open(`/radar-trade?symbol=${encodeURIComponent(signal.symbol)}`, "_self");
  }, []);

  const loadSignals = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchAPI<SignalResponse>("/api/signals");
      if (res.success) {
        setData(res);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not fetch signals.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadSignals();
    const interval = setInterval(() => {
      loadSignals();
      setCountdown(REFRESH_INTERVAL);
    }, REFRESH_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, [loadSignals]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? REFRESH_INTERVAL : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const allRows = useMemo(() => {
    const signals = data?.signals ?? [];
    return signals
      .map((signal, index) => buildQueueRow(signal, index + 1))
      .sort((a, b) => b.confidence - a.confidence || Math.abs(b.oiChangePct) - Math.abs(a.oiChangePct));
  }, [data]);

  const filteredRows = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return allRows.filter((row) => {
      if (!isPremium && isPremiumSignal(row.signal)) return false;
      if (setupFilter !== "all" && row.setup !== setupFilter) return false;
      if (biasFilter !== "all" && row.bias !== biasFilter) return false;
      if (riskFilter !== "all" && row.risk !== riskFilter) return false;
      if (minConfidence && row.confidence < minConfidence) return false;
      if (searchText && !`${row.symbol} ${row.sector} ${row.trigger}`.toLowerCase().includes(searchText)) return false;
      return true;
    });
  }, [allRows, biasFilter, isPremium, minConfidence, riskFilter, search, setupFilter]);

  const premiumRows = useMemo(() => {
    if (isPremium) return [];
    return allRows.filter((row) => isPremiumSignal(row.signal));
  }, [allRows, isPremium]);

  const selectedRow = filteredRows.find((row) => row.key === selectedSignalKey) ?? filteredRows[0] ?? null;
  const sectorBreadth = useMemo(() => buildSectorBreadth(allRows), [allRows]);

  const summary = data?.summary ?? { bullish: 0, bearish: 0, neutral: 0, strongSignals: 0, total: 0 };
  const activeCount = filteredRows.filter((row) => row.status === "ACTIVE").length;
  const marketScore = clamp(Math.round(((summary.bullish + activeCount) / Math.max(summary.total + activeCount, 1)) * 100), 0, 100);

  function resetFilters() {
    setSetupFilter("all");
    setBiasFilter("all");
    setRiskFilter("all");
    setMinConfidence(0);
    setSearch("");
  }

  return (
    <div className="trader-cockpit text-foreground">
      <div className="min-w-0">

        <div className="min-w-0 space-y-4">
          <div className="grid gap-3 min-[1650px]:grid-cols-[minmax(0,1.7fr)_minmax(340px,1fr)]">
            <SignalQueuePanel
              rows={filteredRows}
              allCount={allRows.length}
              selectedKey={selectedRow?.key ?? null}
              setupFilter={setupFilter}
              biasFilter={biasFilter}
              riskFilter={riskFilter}
              minConfidence={minConfidence}
              search={search}
              loading={loading}
              error={error}
              countdown={countdown}
              premiumRows={premiumRows}
              onSelect={(row) => setSelectedSignalKey(row.key)}
              onSetupFilter={setSetupFilter}
              onBiasFilter={setBiasFilter}
              onRiskFilter={setRiskFilter}
              onMinConfidence={setMinConfidence}
              onSearch={setSearch}
              onReset={resetFilters}
              onOpen={openSignalDecision}
            />

            <SelectedSignalDesk
              row={selectedRow}
              onOpen={openSignalDecision}
            />
          </div>

          {data && <div className="grid gap-3 min-[1550px]:grid-cols-[1fr_1fr_1.2fr]">
            <SectorBreadthPanel rows={allRows} sectors={sectorBreadth} />
            <AbnormalParticipationPanel rows={allRows} />
            {summary.total > 0 ? <MarketPulsePanel summary={summary} marketScore={marketScore} timestamp={data?.timestamp} /> : <section className="rounded-xl border border-card-border bg-card p-4"><h3 className="text-sm font-semibold text-text-heading">Signal balance</h3><p className="mt-2 text-sm text-muted">No signals are available in this sample.</p></section>}
          </div>}

          <div className="flex flex-col gap-2 border-t border-card-border pt-3 text-[11px] text-muted md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-4">
              <span>Last updated: {lastUpdatedLabel(data?.timestamp)}</span>
              <span>Auto-refresh {isMarketOpen() ? "ON" : "last-session mode"}</span>
              <span>Data: NSE options, cash, and radar signals</span>
            </div>
            <span>Screening tool only. Not investment advice.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SignalQueuePanel({
  rows,
  allCount,
  selectedKey,
  setupFilter,
  biasFilter,
  riskFilter,
  minConfidence,
  search,
  loading,
  error,
  countdown,
  premiumRows,
  onSelect,
  onSetupFilter,
  onBiasFilter,
  onRiskFilter,
  onMinConfidence,
  onSearch,
  onReset,
  onOpen,
}: {
  rows: QueueRow[];
  allCount: number;
  selectedKey: string | null;
  setupFilter: SetupFilter;
  biasFilter: BiasFilter;
  riskFilter: RiskFilter;
  minConfidence: number;
  search: string;
  loading: boolean;
  error: string | null;
  countdown: number;
  premiumRows: QueueRow[];
  onSelect: (row: QueueRow) => void;
  onSetupFilter: (filter: SetupFilter) => void;
  onBiasFilter: (filter: BiasFilter) => void;
  onRiskFilter: (filter: RiskFilter) => void;
  onMinConfidence: (value: number) => void;
  onSearch: (value: string) => void;
  onReset: () => void;
  onOpen: (signal: Signal) => void;
}) {
  const setupCounts = {
    all: allCount,
    intraday: rows.filter((row) => row.setup === "intraday").length,
    swing: rows.filter((row) => row.setup === "swing").length,
    positional: rows.filter((row) => row.setup === "positional").length,
  };

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card ">
      <div className="flex flex-col gap-3 border-b border-card-border px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-heading">Signal queue</h2>
          <p className="mt-1 text-xs text-muted">Ranked opportunities by real-time edge, conviction, and tradability.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative h-9 w-full min-w-[230px] sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              aria-label="Filter signals"
              placeholder="Search symbol, sector, trigger..."
              className="h-full w-full rounded-lg border border-card-border bg-page-bg pl-9 pr-3 text-xs text-text-heading outline-none transition-colors placeholder:text-muted focus:border-blue-400/60"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3 border-b border-card-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {([
            ["all", "All Setups", setupCounts.all],
            ["intraday", "Intraday", setupCounts.intraday],
            ["swing", "Swing", setupCounts.swing],
            ["positional", "Positional", setupCounts.positional],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => onSetupFilter(key)}
              className={cn(
                "h-8 rounded-lg border px-3 text-xs font-bold transition-colors",
                setupFilter === key
                  ? "border-blue-400/30 bg-blue-500/20 text-accent"
                  : "border-card-border bg-page-bg text-muted hover:text-text-heading",
              )}
            >
              {label}
              <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px]">{count}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <CompactSelect
            label="All Bias"
            value={biasFilter}
            options={[
              ["all", "All Bias"],
              ["BULLISH", "Bullish"],
              ["BEARISH", "Bearish"],
              ["NEUTRAL", "Neutral"],
            ]}
            onChange={(value) => onBiasFilter(value as BiasFilter)}
          />
          <CompactSelect
            label="Min Confidence"
            value={String(minConfidence)}
            options={[
              ["0", "Min Confidence"],
              ["60", "60%+"],
              ["70", "70%+"],
              ["80", "80%+"],
            ]}
            onChange={(value) => onMinConfidence(Number(value))}
          />
          <CompactSelect
            label="Risk All"
            value={riskFilter}
            options={[
              ["all", "Risk All"],
              ["LOW", "Low"],
              ["MEDIUM", "Medium"],
              ["HIGH", "High"],
            ]}
            onChange={(value) => onRiskFilter(value as RiskFilter)}
          />
          <button type="button" onClick={onReset} className="h-8 rounded-lg px-3 font-semibold text-muted transition-colors hover:bg-white/[0.04] hover:text-text-heading">
            Reset
          </button>

          <div className="ml-auto flex h-8 items-center gap-2 rounded-lg border border-card-border bg-page-bg px-3 text-muted">
            <span className={cn("h-2 w-2 rounded-full", isMarketOpen() ? "animate-pulse bg-emerald-400" : "bg-amber-400")} />
            {isMarketOpen() ? `Refresh ${countdown}s` : "Last session"}
          </div>
        </div>
      </div>

      {error && (
        <div className="m-4 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {loading && !rows.length && (
        <div className="flex min-h-[380px] items-center justify-center">
          <div className="text-center">
            <div className="mx-auto mb-3 h-8 w-8 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            <div className="text-sm font-bold text-text-heading">Analyzing live signal flow</div>
            <div className="mt-1 text-xs text-muted">Building queue from options, price, and volume context.</div>
          </div>
        </div>
      )}

      {!loading && !rows.length && !error && (
        <div className="flex min-h-[320px] items-center justify-center px-4 text-center">
          <div>
            <div className="text-sm font-bold text-text-heading">No visible signals match these filters</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-muted">Relax filters or wait for the next refresh. Strong signals are filtered for premium users when the account is not upgraded.</p>
          </div>
        </div>
      )}

      {premiumRows.length > 0 && (
        <div className="mx-4 mt-4">
          <PremiumLocked
            title={`${premiumRows.length} premium signal${premiumRows.length === 1 ? "" : "s"} hidden`}
            description={`Strong signals and moderate signals with score ${PREMIUM_MODERATE_SCORE}+ are available on Premium.`}
          />
        </div>
      )}

      {rows.length > 0 && (
        <div className="max-h-[650px] overflow-auto">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="sticky top-0 z-10 bg-card text-[10px] uppercase tracking-[0.08em] text-muted">
              <tr className="border-b border-card-border">
                <th className="w-10 px-4 py-3">#</th>
                <th className="px-2 py-3">Symbol</th>
                <th className="px-2 py-3">Bias</th>
                <th className="px-2 py-3">Confidence</th>
                <th className="px-2 py-3 text-right">Price</th>
                <th className="px-2 py-3 text-right">OI Change</th>
                <th className="px-2 py-3 text-right">Vol Surge</th>
                <th className="px-2 py-3">Trigger</th>
                <th className="px-2 py-3">Risk</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={row.key}
                  onClick={() => onSelect(row)}
                  className={cn(
                    "cursor-pointer border-b border-card-border transition-colors hover:bg-blue-500/[0.08]",
                    selectedKey === row.key && "bg-blue-500/[0.13] shadow-[inset_3px_0_0_rgba(59,130,246,0.85)]",
                  )}
                >
                  <td className="px-4 py-3 font-mono text-foreground">{index + 1}</td>
                  <td className="px-2 py-3">
                    <div className="flex items-center gap-2">
                      <Star className={cn("h-4 w-4", index < 3 ? "fill-yellow-300 text-yellow-300" : "text-muted")} aria-hidden="true" />
                      <div>
                        <button type="button" onClick={() => onSelect(row)} aria-pressed={selectedKey === row.key} className="font-semibold text-text-heading hover:text-accent">{row.symbol}</button>
                        <div className="text-[10px] uppercase tracking-wide text-muted">{row.sector}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <span className={cn("rounded-md border px-2 py-1 text-[10px] font-extrabold", biasClasses(row.bias))}>
                      {row.bias}
                    </span>
                  </td>
                  <td className="px-2 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-7 text-right font-mono font-bold text-text-heading">{row.confidence}</span>
                      <div className="h-2 w-20 overflow-hidden rounded-full bg-card-border">
                        <div
                          className={cn("h-full rounded-full", row.confidence >= 75 ? "bg-emerald-400" : row.confidence >= 60 ? "bg-lime-300" : "bg-slate-500")}
                          style={{ width: `${row.confidence}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-3 text-right font-mono">
                    <div className="font-bold text-text-heading">{formatNumber(row.price)}</div>
                    <div className={cn("text-[10px]", textTone(row.changePct))}>{row.changePct >= 0 ? "+" : ""}{metricValue(row.changePct, 2, "%")}</div>
                  </td>
                  <td className="px-2 py-3 text-right font-mono">
                    <div className={cn("font-bold", textTone(row.oiChangePct))}>{row.oiChangePct >= 0 ? "+" : ""}{metricValue(row.oiChangePct, 1, "%")}</div>
                    <div className="text-[10px] text-muted">{formatOI(row.oiChangeValue)}</div>
                  </td>
                  <td className="px-2 py-3 text-right font-mono">
                    <div className="font-bold text-text-heading">{metricValue(row.volumeSurge, 1, "x")}</div>
                    <div className={cn("text-[10px]", row.volumeSurge >= 2 ? "text-profit" : "text-muted")}>
                      {!Number.isFinite(row.volumeSurge) ? "unavailable" : row.volumeSurge >= 2 ? "strong" : "normal"}
                    </div>
                  </td>
                  <td className="px-2 py-3 font-semibold text-foreground">{row.trigger}</td>
                  <td className="px-2 py-3">
                    <span className={cn("rounded-md border px-2 py-1 text-[10px] font-extrabold", riskClasses(row.risk))}>{row.risk}</span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(row.signal);
                      }}
                      className={cn("rounded-md border px-2 py-1 text-[10px] font-extrabold transition-colors hover:border-blue-300", statusClasses(row.status))}
                    >
                      {row.status}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CompactSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 appearance-none rounded-lg border border-card-border bg-page-bg pl-3 pr-8 text-xs font-semibold text-foreground outline-none transition-colors hover:text-text-heading focus:border-blue-400/60"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue} className="bg-page-bg text-text-heading">
            {optionLabel}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
    </label>
  );
}

function SelectedSignalDesk({ row, onOpen }: { row: QueueRow | null; onOpen: (signal: Signal) => void }) {
  if (!row) return <aside className="rounded-xl border border-card-border bg-card p-6"><h2 className="font-semibold text-text-heading">Signal details</h2><p className="mt-2 text-sm text-muted">Select a signal to review its evidence and trade plan.</p></aside>;
  const signal = row.signal;
  const cash = signalCash(signal);
  const candidate = toSignalRadarCandidate(signal);
  const recommendation = signal.recommendation;
  const metrics = [
    ["Spot", row.price ? formatNumber(row.price) : "—"],
    ["Signal score", String(signal.score)],
    ["Confidence", signal.confidence],
    ["PCR", signalPcr(signal) ? signalPcr(signal).toFixed(2) : "—"],
    ["Max pain", signalMaxPain(signal) ? formatNumber(signalMaxPain(signal)) : "—"],
    ["Expiry", signal.expiry || "—"],
    ["Cash entry", cash?.entry ? formatNumber(cash.entry) : "—"],
    ["Stop loss", candidate.stop ? formatNumber(candidate.stop) : "—"],
    ["Target 1", cash?.target1 ? formatNumber(cash.target1) : "—"],
    ["Target 2", cash?.target2 ? formatNumber(cash.target2) : "—"],
    ["Risk / reward", candidate.riskReward ? `1:${candidate.riskReward.toFixed(2)}` : "—"],
    ["Volume ratio", metricValue(row.volumeSurge, 1, "x")],
  ];
  return <aside className="rounded-xl border border-card-border bg-card overflow-hidden">
    <div className="flex items-center justify-between border-b border-card-border p-5"><div><p className="eyebrow mb-2">Selected signal</p><h2 className="text-xl font-semibold text-text-heading">{row.symbol}</h2><p className="mt-1 text-xs text-muted">{row.sector}</p></div><span className={cn("rounded-md border px-3 py-1 text-xs", biasClasses(row.bias))}>{row.bias}</span></div>
    <dl className="grid grid-cols-2 gap-px bg-card-border sm:grid-cols-3 min-[1650px]:grid-cols-2">{metrics.map(([label,value]) => <div key={label} className="bg-card px-5 py-4"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 font-mono text-sm text-text-heading">{value}</dd></div>)}</dl>
    <div className="border-t border-card-border p-5"><h3 className="text-sm font-semibold text-text-heading">Signal evidence</h3><ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted">{(signal.reasons || []).map((reason,index) => <li key={index}>{reason}</li>)}</ul>{!signal.reasons?.length && <p className="mt-2 text-sm text-muted">No supporting notes were supplied.</p>}</div>
    {recommendation && <details className="border-t border-card-border p-5"><summary className="text-sm font-semibold cursor-pointer">Options recommendation</summary><div className="mt-3 grid gap-2 text-sm">{Object.entries(recommendation).map(([key,value]) => <div key={key} className="flex flex-wrap justify-between gap-2"><span className="text-muted">{key.replace(/([A-Z])/g," $1").replaceAll("_"," ")}</span><span className="break-all text-text-heading">{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</span></div>)}</div></details>}
    <div className="border-t border-card-border p-5 space-y-3"><p className="text-xs leading-relaxed text-muted">Open the cockpit for sourced price history, market depth and liquidity checks. Missing values are shown as a dash.</p><button type="button" className="workspace-button primary w-full" onClick={() => onOpen(signal)}>Open trade cockpit</button><Link className="workspace-button w-full" href="/trade-ideas?tab=alerts">Manage alerts</Link></div>
  </aside>;
}

function metricValue(value: number, digits = 1, suffix = "") {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function SectorBreadthPanel({ rows, sectors }: { rows: QueueRow[]; sectors: SectorBreadth[] }) {
  const advancers = rows.filter((row) => row.changePct > 0).length;
  const decliners = rows.filter((row) => row.changePct < 0).length;
  const unchanged = Math.max(rows.length - advancers - decliners, 0);
  const chart = [
    { name: "Advancing", value: advancers, fill: "#34d399" },
    { name: "Declining", value: decliners, fill: "#fb7185" },
    { name: "Unchanged", value: unchanged, fill: "#64748b" },
  ];

  return (
    <section className="rounded-xl border border-card-border bg-card p-4">
      <h3 className="text-xs font-extrabold uppercase tracking-wide text-text-heading">Signal sector breadth</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-[132px_minmax(0,1fr)]">
        <div className="relative h-32">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={chart} dataKey="value" innerRadius={38} outerRadius={58} paddingAngle={2}>
                {chart.map((item) => (
                  <Cell key={item.name} fill={item.fill} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="font-mono text-lg font-extrabold text-text-heading">{advancers}</span>
            <span className="text-[10px] text-muted">Advancing</span>
          </div>
        </div>
        <div className="space-y-2">
          {sectors.slice(0, 5).map((sector) => (
            <div key={sector.name} className="flex items-center justify-between gap-3 text-xs">
              <div className="min-w-0">
                <div className="truncate font-bold text-foreground">{sector.name}</div>
                <div className="truncate text-[10px] text-muted">{sector.leaders.join(", ")}</div>
              </div>
              <span className={cn("font-mono font-bold", textTone(sector.change))}>{sector.change >= 0 ? "+" : ""}{sector.change.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
        <TinyCounter label="Adv" value={advancers} tone="profit" />
        <TinyCounter label="Decl" value={decliners} tone="loss" />
        <TinyCounter label="Unch" value={unchanged} />
      </div>
    </section>
  );
}

function TinyCounter({ label, value, tone }: { label: string; value: number; tone?: "profit" | "loss" }) {
  return (
    <div className="rounded-lg bg-page-bg p-2">
      <div className={cn("font-mono text-lg font-extrabold text-text-heading", tone === "profit" && "text-profit", tone === "loss" && "text-loss")}>{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

function AbnormalParticipationPanel({ rows }: { rows: QueueRow[] }) {
  const top = rows.filter(row => Number.isFinite(row.oiChangePct) && Number.isFinite(row.volumeSurge))
    .sort((a, b) => Math.abs(b.oiChangePct) + b.volumeSurge - (Math.abs(a.oiChangePct) + a.volumeSurge))
    .slice(0, 5);
  return (
    <section className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-extrabold uppercase tracking-wide text-text-heading">Abnormal Participation</h3>

      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-card-border">
        <table className="w-full text-xs">
          <thead className="bg-page-bg text-[10px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 text-left">Symbol</th>
              <th className="px-3 py-2 text-left">Sector</th>
              <th className="px-3 py-2 text-right">Metric</th>
              <th className="px-3 py-2 text-right">Vs Avg</th>
            </tr>
          </thead>
          <tbody>
            {top.map((row) => (
              <tr key={row.key} className="border-t border-card-border">
                <td className="px-3 py-2 font-bold text-text-heading">{row.symbol}</td>
                <td className="px-3 py-2 text-foreground">{row.sector}</td>
                <td className={cn("px-3 py-2 text-right font-mono font-bold", textTone(row.oiChangePct))}>{row.oiChangePct >= 0 ? "+" : ""}{metricValue(row.oiChangePct, 1, "%")}</td>
                <td className="px-3 py-2 text-right font-mono text-profit">{metricValue(row.volumeSurge, 1, "x")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MarketPulsePanel({ summary, marketScore, timestamp }: { summary: SignalResponse["summary"]; marketScore: number; timestamp?: number }) {
  const angle = -90 + (marketScore / 100) * 180;
  const needleStyle = { transform: `rotate(${angle}deg)` } as CSSProperties;

  return (
    <section className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-extrabold uppercase tracking-wide text-text-heading">Signal balance</h3>

      </div>

      <p className="mt-2 text-xs text-muted">Based on the loaded signal sample.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_180px]">
        <div className="space-y-2 text-xs">
          {[
            ["Bullish Signals", summary.bullish, "profit"],
            ["Bearish Signals", summary.bearish, "loss"],
            ["Neutral Signals", summary.neutral, "muted"],
            ["Strong Signals", summary.strongSignals, "profit"],
          ].map(([label, value, tone]) => (
            <div key={String(label)} className="flex items-center justify-between rounded-lg bg-page-bg px-3 py-2">
              <span className="text-foreground">{label}</span>
              <span className={cn("font-mono font-bold text-text-heading", tone === "profit" && "text-profit", tone === "loss" && "text-loss")}>{value}</span>
            </div>
          ))}
          <div className="text-[10px] text-muted">Updated {lastUpdatedLabel(timestamp)}</div>
        </div>

        <div className="flex flex-col items-center justify-center">
          <div className="relative h-24 w-44 overflow-hidden">
            <div
              className="absolute inset-x-0 top-0 h-44 rounded-full"
              style={{
                background: "conic-gradient(from 270deg, #34d399 0deg 65deg, #facc15 65deg 116deg, #fb7185 116deg 180deg, transparent 180deg)",
              }}
            />
            <div className="absolute inset-x-6 top-6 h-32 rounded-full bg-card" />
            <div className="absolute bottom-0 left-1/2 h-1 w-16 origin-left rounded-full bg-slate-100" style={needleStyle} />
            <div className="absolute bottom-[-3px] left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-slate-100" />
          </div>
          <div className="mt-2 text-center">
            <div className={cn("text-sm font-extrabold uppercase", marketScore >= 60 ? "text-profit" : marketScore <= 40 ? "text-loss" : "text-warning")}>
              {marketScore >= 60 ? "Bullish" : marketScore <= 40 ? "Bearish" : "Neutral"}
            </div>
            <div className="font-mono text-xl font-extrabold text-text-heading">{marketScore} / 100</div>
          </div>
        </div>
      </div>
    </section>
  );
}
