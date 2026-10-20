"use client";

import Link from "next/link";
import { PageHeader } from "../layout/PageHeader";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Crosshair,
  Layers3,
  ListFilter,
  Radio,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { fetchAPI, postAPI } from "../../lib/api";
import { SECTOR_INDICES } from "../../lib/sector-indices";
import { getUniverse } from "../../lib/stock-universe";
import { cn, formatNumber } from "../../lib/utils";

type Bias = "LONG" | "SHORT" | "NEUTRAL";
type Verdict = "TRADE" | "WAIT" | "AVOID";
type Tone = "profit" | "warning" | "loss" | "accent" | "neutral";

interface IndexRow {
  key?: string;
  name?: string;
  symbol?: string;
  ltp?: number;
  last?: number;
  chg?: number;
  chgPct?: number;
  change?: number;
  changePct?: number;
  changePercent?: number;
}

interface IndicesResponse {
  indices?: IndexRow[];
  data?: IndexRow[];
  cached?: boolean;
  cachedAt?: string;
  timestamp?: number | string;
}

interface SectorQuote {
  name: string;
  symbol?: string;
  last: number;
  changePct: number;
  change: number;
}

interface SectorQuotesResponse {
  success?: boolean;
  sectors?: Array<Record<string, unknown>>;
  data?: Array<Record<string, unknown>>;
}

interface RadarCandidate {
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
  volRatio: number;
  rFactor: number;
  sector: string;
  freshness?: { status: "fresh" | "stale" | "unknown"; ageSeconds: number | null };
  dataWarnings?: string[];
  reasons: string[];
}

interface RadarResponse {
  success: boolean;
  marketRegime: {
    label: string;
    bias: Bias;
    confidence: number;
    breadthPct?: number;
    advancing?: number;
    declining?: number;
    avgChangePct?: number;
    notes: string[];
  };
  summary: {
    total: number;
    long: number;
    short: number;
    neutral: number;
    actionable: number;
    avgScore: number;
  };
  candidates: RadarCandidate[];
  actionable?: RadarCandidate[];
  timestamp: number;
  cached?: boolean;
  cachedAt?: string;
  cachedAgeSeconds?: number;
  provider?: {
    provider?: string;
    requested?: number;
    returned?: number;
    elapsedMs?: number;
    fallback?: boolean;
    fallbackReason?: string;
  };
}

interface TodayState {
  indices: IndicesResponse | null;
  radar: RadarResponse | null;
}

const RADAR_CANDIDATE_STORAGE_KEY = "alpha-radar:selected-candidate";
const PRIMARY_REFRESH_MS = 30_000;

const INITIAL_CLOCK = { time: "--:--:-- IST", date: "Loading IST", isOpen: false };

export default function TodayDeskContent() {
  const [state, setState] = useState<TodayState>({
    indices: null,
    radar: null,
  });
  const [radarLoading, setRadarLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [clock, setClock] = useState(INITIAL_CLOCK);
  const [queueFilter, setQueueFilter] = useState<"all" | Verdict>("all");
  const [search, setSearch] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  const loadPrimary = useCallback(async () => {
    const [indicesRes, radarRes] = await Promise.allSettled([
      fetchAPI<IndicesResponse>("/api/quotes/indices"),
      postAPI<RadarResponse>("/api/intraday/radar", {
        symbols: getUniverse("nifty100"),
        minTradedValueLakh: 0,
        useCache: true,
        quoteProvider: "arrow_first",
      }),
    ]);

    setState((prev) => ({
      ...prev,
      indices: settledValue(indicesRes, prev.indices),
      radar: radarRes.status === "fulfilled" && radarRes.value.success ? radarRes.value : null,
    }));
    setLastRefresh(Date.now());
    setError(radarRes.status === "rejected"
      ? shortError(radarRes.reason)
      : radarRes.value.success
        ? null
        : "Live radar returned no usable response.");
    setRadarLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (cancelled) return;
      await loadPrimary();
    }

    run();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void run(); }, PRIMARY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadPrimary]);

  useEffect(() => {
    setClock(getIstClock());
    const timer = window.setInterval(() => setClock(getIstClock()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const indices = useMemo(() => normalizeIndices(state.indices), [state.indices]);
  const nifty = findIndex(indices, ["NIFTY 50", "NIFTY50", "NIFTY"]);
  const vix = findIndex(indices, ["INDIA VIX", "VIX", "INDIAVIX"]);
  const queue = useMemo(() => buildDecisionQueue(state.radar, search, queueFilter), [queueFilter, search, state.radar]);
  const marketTone: Tone = state.radar?.marketRegime.bias === "SHORT" ? "loss" : state.radar?.marketRegime.bias === "LONG" ? "profit" : "warning";
  const statusText = clock.isOpen ? "Market Open" : "Market Closed";
  const selectedCandidate = useMemo(() => {
    const allCandidates = queue.map((row) => row.candidate);
    return allCandidates.find((candidate) => candidate.symbol === selectedSymbol)
      || allCandidates[0]
      || null;
  }, [queue, selectedSymbol]);
  const heatmap = useMemo(() => buildSectorHeatmap(state.radar), [state.radar]);

  return (
    <div className="mx-auto max-w-[1880px] space-y-5">
      <PageHeader eyebrow="Your market, in focus" title="Market overview" description="Read the market. Find the setup. Know your risk." actions={<Link href="/pulse" className="workspace-button primary">Open Alpha Radar <ArrowRight size={14} /></Link>} />
      <section aria-label="Market summary">
        <div className="market-summary">
          <MarketHeaderBlock
            icon={ShieldCheck}
            label="Desk View"
            value={state.radar?.marketRegime.label || "Warming Up"}
            tone={marketTone}
            detail={`Regime: ${state.radar?.marketRegime.bias || "WAIT"} / Breadth: ${formatBreadth(state.radar)}`}
          />
          <IndexHeaderBlock label="Nifty 50" index={nifty} fallbackValue="-" />
          <IndexHeaderBlock label="India VIX" index={vix} fallbackValue="-" invertTone />
          <MarketHeaderBlock
            icon={Radio}
            label="Freshness"
            value={radarLoading ? "Checking" : state.radar ? (state.radar.cached ? "Replay" : "Live") : "Unavailable"}
            tone={radarLoading ? "accent" : state.radar?.cached ? "warning" : state.radar ? "profit" : "loss"}
            detail={state.radar && lastRefresh ? `Checked ${new Date(lastRefresh).toLocaleTimeString("en-IN")}` : radarLoading ? "Starting live checks" : "No live radar response"}
          />
          <MarketHeaderBlock
            icon={Clock3}
            label="Trading session"
            value={clock.date}
            tone={clock.isOpen ? "profit" : "warning"}
            detail={statusText}
          />
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-warning/25 bg-warning/10 px-4 py-3 text-sm text-warning">
          The intraday radar could not be updated: {error}
        </div>
      )}

      <SectorHeatmapPanel rows={heatmap} />

      <section className="grid grid-cols-1 gap-5 min-[1350px]:grid-cols-[minmax(0,1fr)_360px]">
        <SignalQueuePanel
          rows={queue}
          filter={queueFilter}
          search={search}
          selectedSymbol={selectedCandidate?.symbol || ""}
          emptyMessage={radarLoading
            ? "Checking the live radar..."
            : !state.radar
              ? "The radar feed is unavailable. Please try again shortly."
              : (state.radar.candidates?.length || 0) === 0
                ? "No live signals right now."
                : "No live signals match this filter."}
          onFilterChange={setQueueFilter}
          onSearchChange={setSearch}
          onSelect={(candidate) => setSelectedSymbol(candidate.symbol)}
        />

        {selectedCandidate ? (
          <SelectedSetupPanel
            candidate={selectedCandidate}
            verdict={verdictFor(selectedCandidate)}
            radar={state.radar}
            onOpenDecision={openRadarDecision}
          />
        ) : (
          <section className="flex min-h-72 items-center justify-center rounded-lg border border-card-border bg-card p-8 text-center">
            <div>
              <h2 className="text-base font-black text-text-heading">No live setup selected</h2>
              <p className="mt-2 max-w-sm text-sm text-muted">
                {radarLoading ? "Waiting for the live radar response." : "A setup will appear here only when the live radar returns a candidate."}
              </p>
            </div>
          </section>
        )}
      </section>
      <p className="pb-1 text-xs text-muted">
        Screening and risk tool only. Not investment advice. Use the cockpit to validate trend, location, liquidity, and invalidation before any trade.
      </p>
    </div>
  );
}

function SectorHeatmapPanel({ rows }: { rows: SectorHeatRow[] }) {
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [sectorQuotes, setSectorQuotes] = useState<Record<string, SectorQuote>>({});
  const [sectorLoading, setSectorLoading] = useState(true);
  const [sectorError, setSectorError] = useState<string | null>(null);

  const rotationRows = useMemo(() => buildSectorRotationRows(sectorQuotes, rows), [rows, sectorQuotes]);
  const leaders = useMemo(() => rotationRows.filter((row) => row.changePct >= 0).slice(0, 3), [rotationRows]);
  const laggards = useMemo(() => [...rotationRows].filter((row) => row.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 3), [rotationRows]);
  const activeRow = useMemo(() => {
    if (rotationRows.length === 0) return null;
    return rotationRows.find((row) => row.sector === selectedSector) || rotationRows[0];
  }, [rotationRows, selectedSector]);

  useEffect(() => {
    let cancelled = false;

    async function loadSectorQuotes() {
      setSectorLoading(true);
      try {
        const result = await fetchAPI<SectorQuotesResponse>("/api/quotes/sectors");
        if (cancelled) return;
        setSectorQuotes(buildSectorQuoteMap(result));
        setSectorError(null);
      } catch (error) {
        if (cancelled) return;
        setSectorError(shortError(error));
        setSectorQuotes({});
      } finally {
        if (!cancelled) setSectorLoading(false);
      }
    }

    void loadSectorQuotes();
    const interval = window.setInterval(() => void loadSectorQuotes(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!rotationRows.length) return;
    if (!selectedSector || !rotationRows.some((row) => row.sector === selectedSector)) {
      setSelectedSector(rotationRows[0].sector);
    }
  }, [rotationRows, selectedSector]);

  return (
    <section className="rounded-lg border border-card-border bg-card px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="flex shrink-0 items-center justify-between gap-4 xl:w-52">
          <div>
            <h2 className="text-sm font-black text-text-heading">Sector Rotation</h2>
            <p className="mt-0.5 text-[11px] text-muted">
              {sectorLoading ? "Updating sector tape..." : sectorError ? "Using radar fallback" : `${rotationRows.length} sectors tracked`}
            </p>
          </div>
          <Link href="/sectors" className="text-xs font-bold text-accent hover:underline">View all</Link>
        </div>

        <div className="h-px bg-card-border xl:h-9 xl:w-px" />

        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <SectorChipGroup label="Leaders" rows={leaders} selectedSector={activeRow?.sector} onSelect={setSelectedSector} />
          <SectorChipGroup label="Laggards" rows={laggards} selectedSector={activeRow?.sector} onSelect={setSelectedSector} />
        </div>

        {activeRow && (
          <div className="shrink-0 rounded border border-card-border bg-surface-subtle px-3 py-2 text-xs xl:max-w-64">
            <span className="font-black text-text-heading">{sectorDisplayName(activeRow.sector)}</span>
            <span className={cn("ml-2 font-mono font-black", signedTone(activeRow.changePct))}>{formatSigned(activeRow.changePct)}</span>
            <span className="ml-2 text-muted">{activeRow.count} names</span>
          </div>
        )}
      </div>
    </section>
  );
}

function SectorChipGroup({
  label,
  rows,
  selectedSector,
  onSelect,
}: {
  label: string;
  rows: SectorHeatRow[];
  selectedSector?: string;
  onSelect: (sector: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[10px] font-black uppercase tracking-wide text-muted">{label}</span>
      <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5">
        {rows.map((row) => (
          <button
            key={`${label}-${row.sector}`}
            type="button"
            onClick={() => onSelect(row.sector)}
            aria-pressed={selectedSector === row.sector}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1.5 text-xs transition hover:bg-hover-bg",
              selectedSector === row.sector && "border-accent bg-accent-bg",
            )}
          >
            <span className="font-bold text-text-heading">{sectorDisplayName(row.sector)}</span>
            <span className={cn("font-mono font-black", signedTone(row.changePct))}>{formatSigned(row.changePct)}</span>
          </button>
        ))}
        {rows.length === 0 && <span className="py-1.5 text-xs text-muted">None</span>}
      </div>
    </div>
  );
}

function SignalQueuePanel({
  rows,
  filter,
  search,
  selectedSymbol,
  emptyMessage,
  onFilterChange,
  onSearchChange,
  onSelect,
}: {
  rows: Array<{ candidate: RadarCandidate; verdict: Verdict; note: string }>;
  filter: "all" | Verdict;
  search: string;
  selectedSymbol: string;
  emptyMessage: string;
  onFilterChange: (filter: "all" | Verdict) => void;
  onSearchChange: (value: string) => void;
  onSelect: (candidate: RadarCandidate) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-card-border bg-card">
      <div className="flex flex-col gap-3 border-b border-card-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ListFilter className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-text-heading">Opportunity queue</h2>
            <span className="rounded bg-accent-bg px-2 py-0.5 text-[10px] font-bold text-accent">{rows.length}</span>
          </div>
          <p className="mt-1 text-xs text-muted">Ranked setups. Select a symbol to review its trade plan.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-[240px] items-center gap-2 rounded border border-card-border bg-page-bg/70 px-3 py-2 text-xs text-muted">
            <Search className="h-3.5 w-3.5" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted"
              aria-label="Filter opportunities by symbol or sector" placeholder="Search symbol or sector…"
            />
          </label>
          <div className="flex rounded border border-card-border bg-page-bg/70 p-0.5">
            {(["all", "TRADE", "WAIT", "AVOID"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onFilterChange(item)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
                  filter === item ? "bg-accent text-white" : "text-muted hover:text-foreground",
                )}
              >
                {item === "all" ? "All" : item[0] + item.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-h-[620px] overflow-auto">
        <table className="w-full min-w-[580px] text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-card-border text-left text-muted">
              <th className="px-4 py-2">#</th>
              <th className="px-2 py-2">Symbol</th>
              <th className="px-2 py-2">Bias</th>
              <th className="px-2 py-2 text-right">Score</th>
              <th className="px-2 py-2 text-right">Move</th>
              <th className="px-4 py-2">Trigger</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map(({ candidate, verdict, note }, index) => {
              const selected = candidate.symbol === selectedSymbol;
              return (
                <tr
                  key={`${candidate.symbol}-${verdict}`}
                  onClick={() => onSelect(candidate)}
                  className={cn(
                    "cursor-pointer border-b border-card-border/30 transition hover:bg-hover-bg",
                    selected && "bg-accent-bg",
                  )}
                >
                  <td className="px-4 py-3 text-muted">{index + 1}</td>
                  <td className="px-2 py-3">
                    <div className="flex items-center gap-2">
                      <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold text-white", verdictDot(verdict))}>
                        {candidate.symbol.charAt(0)}
                      </span>
                      <span>
                        <button type="button" onClick={() => onSelect(candidate)} aria-pressed={selected} className="block font-semibold text-text-heading hover:text-accent">{candidate.symbol}</button>
                        <span className="block text-[10px] text-muted">{candidate.sector || "NSE"}</span>
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", biasBadge(candidate.bias))}>{candidate.bias}</span>
                  </td>
                  <td className={cn("px-2 py-3 text-right font-black", scoreTone(candidate))}>{Math.round(candidate.score)}</td>
                  <td className="px-2 py-3 text-right">
                    <div className={signedTone(candidate.changePct)}>{formatSigned(candidate.changePct)}</div>
                    <div className="text-[10px] text-muted">{candidate.volRatio.toFixed(1)}x RVOL</div>
                  </td>
                  <td className="max-w-[240px] px-4 py-3">
                    <div className="truncate text-foreground" title={setupText(candidate)}>{setupText(candidate)}</div>
                    <div className="truncate text-[10px] text-muted" title={note}>{note}</div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-muted">{emptyMessage}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SelectedSetupPanel({
  candidate,
  verdict,
  radar,
  onOpenDecision,
}: {
  candidate: RadarCandidate;
  verdict: Verdict;
  radar: RadarResponse | null;
  onOpenDecision: (candidate: RadarCandidate) => void;
}) {
  const rr = candidate.riskReward ?? candidate.rFactor ?? null;
  const marketAligned = !radar || radar.marketRegime.bias === candidate.bias || radar.marketRegime.bias === "NEUTRAL";
  const checklist = [
    { label: "Regime alignment", detail: marketAligned ? "Bias is not fighting the tape" : `Market is ${radar?.marketRegime.bias}`, ok: marketAligned },
    { label: "Volume confirmation", detail: `${candidate.volRatio.toFixed(1)}x relative volume`, ok: candidate.volRatio >= 1.5 },
    { label: "Risk/reward", detail: rr ? `${rr.toFixed(1)}R available` : "Needs manual risk check", ok: !!rr && rr >= 1.5 },
    { label: "Freshness", detail: candidate.freshness?.status || "unknown", ok: candidate.freshness?.status !== "stale" },
  ];
  const tone: Tone = verdict === "TRADE" ? "profit" : verdict === "WAIT" ? "warning" : "loss";

  return (
    <section className="overflow-hidden rounded-lg border border-card-border bg-card">
      <div className="border-b border-card-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-text-heading">{candidate.symbol}</h2>
              <span className={cn("rounded px-2 py-1 text-[11px] font-black", biasBadge(candidate.bias))}>{candidate.bias}</span>
              <span className={cn("rounded px-2 py-1 text-[11px] font-black", verdictBadge(verdict))}>{verdict}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{candidate.sector || "NSE"} / {setupText(candidate)}</p>
          </div>
          <button
            type="button"
            onClick={() => onOpenDecision(candidate)}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-accent px-3 py-2 text-xs font-black text-white hover:bg-accent/90"
          >
            Open Cockpit
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 2xl:grid-cols-2">
          <DeskMetric label="LTP" value={formatPrice(candidate.ltp || candidate.entry)} tone="neutral" />
          <DeskMetric label="Change" value={formatSigned(candidate.changePct)} tone={candidate.changePct >= 0 ? "profit" : "loss"} />
          <DeskMetric label="Score" value={Math.round(candidate.score)} tone={tone} />
          <DeskMetric label="RVOL" value={`${candidate.volRatio.toFixed(1)}x`} tone={candidate.volRatio >= 1.5 ? "profit" : "warning"} />
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <PlanLevel label="Entry" value={candidate.entry} tone="accent" />
          <PlanLevel label="Stop" value={candidate.stop} tone="loss" />
          <PlanLevel label="Target" value={candidate.target1} tone="profit" />
        </div>

        <div className={cn("rounded-lg border p-3", verdictScoreClass(verdict))}>
          <div className="flex items-center gap-2 text-sm font-black">
            {verdict === "TRADE" ? <TrendingUp className="h-4 w-4" /> : verdict === "AVOID" ? <TrendingDown className="h-4 w-4" /> : <Crosshair className="h-4 w-4" />}
            {verdict === "TRADE" ? "Trade candidate, still validate execution" : verdict === "WAIT" ? "Wait for better location or confirmation" : "Avoid until structure improves"}
          </div>
          <p className="mt-2 text-xs text-muted">{candidate.reasons?.[0] || candidate.invalidation}</p>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase text-muted">
            <CheckCircle2 className="h-3.5 w-3.5 text-accent" />
            Action Checklist
          </div>
          <div className="space-y-2">
            {checklist.map((item) => (
              <div key={item.label} className="grid grid-cols-[18px_1fr] gap-2 rounded border border-card-border bg-surface-subtle px-3 py-2 text-xs">
                <span className={cn("mt-0.5 h-3 w-3 rounded-full", item.ok ? "bg-profit" : "bg-warning")} />
                <span>
                  <span className="block font-bold text-text-heading">{item.label}</span>
                  <span className="block text-muted">{item.detail}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-card-border bg-surface-subtle p-3 text-xs">
          <div className="mb-2 flex items-center gap-2 font-black text-text-heading">
            <Layers3 className="h-3.5 w-3.5 text-accent" />
            Options / Depth Lens
          </div>
          <p className="text-muted">
            Use the full cockpit to confirm OI clock, bid/ask spread, liquidity quality, and order depth before entry.
          </p>
        </div>
      </div>
    </section>
  );
}

function DeskMetric({ label, value, tone }: { label: string; value: ReactNode; tone: Tone }) {
  return (
    <div className="rounded border border-card-border bg-surface-subtle px-3 py-2">
      <div className="text-[10px] uppercase text-muted">{label}</div>
      <div className={cn("mt-1 truncate font-mono text-sm font-black", toneText(tone))}>{value}</div>
    </div>
  );
}

function PlanLevel({ label, value, tone }: { label: string; value?: number | null; tone: Tone }) {
  return (
    <div className="rounded border border-card-border bg-surface-subtle px-3 py-2">
      <div className="text-[10px] uppercase text-muted">{label}</div>
      <div className={cn("mt-1 font-mono text-sm font-black", toneText(tone))}>{formatPrice(value)}</div>
    </div>
  );
}

function MarketHeaderBlock({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone: Tone;
}) {
  return (
    <div className="flex min-h-[118px] items-start gap-3 px-4 py-5 max-[600px]:flex-col max-[600px]:gap-2">
      <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", toneSoftBg(tone))}>
        <Icon className={cn("h-5 w-5", toneText(tone))} />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
        <div className={cn("mt-1 text-base font-bold", toneText(tone))}>{value}</div>
        <div className="mt-1 text-xs text-muted" title={detail}>{detail}</div>
      </div>
    </div>
  );
}

function IndexHeaderBlock({
  label,
  index,
  fallbackValue,
  invertTone = false,
}: {
  label: string;
  index: NormalizedIndex | null;
  fallbackValue: string;
  invertTone?: boolean;
}) {
  const change = index?.changePct ?? 0;
  const tone: Tone = change === 0 ? "neutral" : invertTone ? (change < 0 ? "profit" : "loss") : (change > 0 ? "profit" : "loss");

  return (
    <div className="min-h-[118px] px-4 py-5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 flex items-baseline gap-3">
        <div className="text-xl font-bold text-text-heading">{index ? formatPrice(index.last) : fallbackValue}</div>
        {index && <div className={cn("text-sm font-bold", toneText(tone))}>{formatSigned(change)}</div>}
      </div>
<p className="mt-3 text-xs text-muted">Change from previous close</p>
    </div>
  );
}

type SectorHeatRow = {
  sector: string;
  count: number;
  changePct: number;
  last?: number | null;
  symbols?: string[];
  leaders: string[];
  names: SectorStockRow[];
  tone: Tone;
};

type SectorStockRow = {
  symbol: string;
  ltp: number | null;
  changePct: number;
  volume: number | null;
  rvol: number | null;
  score: number;
  signal: string;
  setup: string;
  source: "Sector" | "Radar" | "Abnormal";
};

function normalizeSectorKey(value?: string | null) {
  return String(value || "")
    .toUpperCase()
    .replace(/^NSE:/, "")
    .replace(/NIFTY\s*/g, "")
    .replace(/INDIA\s*/g, "")
    .replace(/INDEX/g, "")
    .replace(/&/g, "AND")
    .replace(/\bPVT\b/g, "PRIVATE")
    .replace(/\bFIN SERVICE\b/g, "FINANCE")
    .replace(/\bFIN SERVICES\b/g, "FINANCE")
    .replace(/\bCAPITAL MKT\b/g, "CAPITAL MARKETS")
    .replace(/\bOIL AND GAS\b/g, "OIL GAS")
    .replace(/\bCONSR DURBL\b/g, "CONSUMER")
    .replace(/\s+/g, " ")
    .trim();
}

function sectorDisplayName(sector: string) {
  return sector
    .replace(/^Nifty\s+/i, "")
    .replace(/^India\s+/i, "")
    .replace(/Oil & Gas/i, "Oil Gas")
    .replace(/Capital Markets/i, "Capital Mkts")
    .replace(/Private Bank/i, "Pvt Bank")
    .replace(/PSU Bank/i, "PSU Bank");
}

function buildSectorQuoteMap(response: SectorQuotesResponse): Record<string, SectorQuote> {
  const rawRows = response.sectors || response.data || [];
  const map: Record<string, SectorQuote> = {};

  for (const raw of rawRows) {
    const name = String(raw.name || raw.symbol || "");
    const symbol = typeof raw.symbol === "string" ? raw.symbol : undefined;
    const last = Number(raw.last ?? raw.last_price ?? raw.ltp ?? 0);
    const changePct = Number(raw.changePct ?? raw.changePercent ?? raw.chgPct ?? raw.pct_change ?? 0);
    const change = Number(raw.change ?? raw.chg ?? 0);
    const quote: SectorQuote = { name, symbol, last, changePct, change };
    map[normalizeSectorKey(name)] = quote;
    if (symbol) map[normalizeSectorKey(symbol)] = quote;
  }

  return map;
}

function buildSectorRotationRows(quotes: Record<string, SectorQuote>, fallbackRows: SectorHeatRow[]): SectorHeatRow[] {
  const fallbackByKey = new Map(fallbackRows.map((row) => [normalizeSectorKey(row.sector), row]));
  const officialRows = SECTOR_INDICES.map((sectorIndex) => {
    const quote = quotes[normalizeSectorKey(sectorIndex.kiteSymbol)] || quotes[normalizeSectorKey(sectorIndex.name)];
    const fallback =
      fallbackByKey.get(normalizeSectorKey(sectorIndex.name)) ||
      fallbackByKey.get(normalizeSectorKey(sectorDisplayName(sectorIndex.name)));
    const changePct = Number.isFinite(quote?.changePct) ? quote!.changePct : fallback?.changePct || 0;
    return {
      sector: sectorIndex.name,
      count: sectorIndex.constituents.length,
      changePct,
      last: quote?.last ?? null,
      symbols: sectorIndex.constituents,
      leaders: fallback?.leaders?.length ? fallback.leaders : sectorIndex.constituents.slice(0, 5),
      names: fallback?.names || [],
      tone: changePct > 0.5 ? "profit" : changePct < -0.35 ? "loss" : Math.abs(changePct) > 0.2 ? "warning" : "neutral",
    } satisfies SectorHeatRow;
  });

  if (officialRows.some((row) => row.last != null || row.changePct !== 0)) {
    return officialRows.sort((a, b) => b.changePct - a.changePct || a.sector.localeCompare(b.sector));
  }

  return [...fallbackRows].sort((a, b) => b.changePct - a.changePct || b.count - a.count);
}

function buildSectorHeatmap(radar: RadarResponse | null): SectorHeatRow[] {
  const rows = new Map<string, { count: number; changeTotal: number; leaders: SectorStockRow[] }>();
  const candidates = radar?.candidates || [];

  for (const candidate of candidates) {
    const sector = candidate.sector || "Other";
    const existing = rows.get(sector) || { count: 0, changeTotal: 0, leaders: [] };
    existing.count += 1;
    existing.changeTotal += candidate.changePct || 0;
    existing.leaders.push({
      symbol: candidate.symbol,
      ltp: candidate.ltp || candidate.entry || null,
      changePct: candidate.changePct || 0,
      volume: candidate.volume || null,
      rvol: candidate.volRatio ?? null,
      score: candidate.score,
      signal: candidate.bias,
      setup: setupText(candidate),
      source: "Radar",
    });
    rows.set(sector, existing);
  }

  return Array.from(rows.entries())
    .map(([sector, value]) => {
      const changePct = value.count ? value.changeTotal / value.count : 0;
      const names = Array.from(
        new Map(
          value.leaders
            .sort((a, b) => b.score - a.score)
            .map((leader) => [leader.symbol, leader]),
        ).values(),
      );
      return {
        sector,
        count: names.length,
        changePct,
        leaders: names.map((leader) => leader.symbol),
        names,
        tone: changePct > 0.5 ? "profit" : changePct < -0.35 ? "loss" : Math.abs(changePct) > 0.2 ? "warning" : "neutral",
      } satisfies SectorHeatRow;
    })
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || b.count - a.count);
}

function buildDecisionQueue(data: RadarResponse | null, search: string, filter: "all" | Verdict) {
  const needle = search.trim().toUpperCase();
  const source = data?.candidates || [];
  return source
    .map((candidate) => ({
      candidate,
      verdict: verdictFor(candidate),
      note: noteFor(candidate),
    }))
    .filter((row) => filter === "all" || row.verdict === filter)
    .filter((row) => !needle || row.candidate.symbol.includes(needle) || row.candidate.sector?.toUpperCase().includes(needle))
    .sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict) || b.candidate.score - a.candidate.score)
    .slice(0, 12);
}

function openRadarDecision(candidate: RadarCandidate) {
  window.sessionStorage.setItem(RADAR_CANDIDATE_STORAGE_KEY, JSON.stringify(candidate));
  window.open(`/radar-trade?symbol=${encodeURIComponent(candidate.symbol)}`, "_self");
}

function verdictFor(candidate: RadarCandidate): Verdict {
  if (candidate.action === "ACTIONABLE" && candidate.score >= 78 && candidate.quality !== "DATA_CHECK") return "TRADE";
  if (candidate.score < 45 || candidate.quality === "DATA_CHECK") return "AVOID";
  return "WAIT";
}

function noteFor(candidate: RadarCandidate) {
  if (candidate.reasons?.[0]) return candidate.reasons[0];
  if (candidate.action === "ACTIONABLE") return "High conviction setup. Use cockpit before entry.";
  if (candidate.score < 45) return "Weak confirmation or poor execution quality.";
  return setupText(candidate);
}

function verdictRank(verdict: Verdict) {
  if (verdict === "TRADE") return 0;
  if (verdict === "WAIT") return 1;
  return 2;
}

function setupText(candidate: RadarCandidate) {
  return (candidate.setups || []).slice(0, 2).map((setup) => setup.replaceAll("_", " ")).join(" + ") || "Radar setup";
}

type NormalizedIndex = { label: string; last: number; changePct: number };

function normalizeIndices(data: IndicesResponse | null): NormalizedIndex[] {
  const rows = data?.indices || data?.data || [];
  return rows.map((row) => ({
    label: String(row.name || row.key || row.symbol || "").replace("NSE:", "").toUpperCase(),
    last: Number(row.ltp ?? row.last ?? 0),
    changePct: Number(row.chg ?? row.chgPct ?? row.changePct ?? row.changePercent ?? 0),
  }));
}

function findIndex(rows: NormalizedIndex[], names: string[]) {
  return rows.find((row) => names.some((name) => row.label.includes(name))) || null;
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T | null): T | null {
  return result.status === "fulfilled" ? result.value : fallback;
}

function shortError(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.replace(/^API error \d+:\s*/, "").trim();
    if (!message || /<!doctype|<html/i.test(message)) return "Live radar is unavailable.";
    return message.slice(0, 160);
  }
  return "Live feed unavailable.";
}

function getIstClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const date = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
  const parts = time.split(":").map(Number);
  const minutes = (parts[0] || 0) * 60 + (parts[1] || 0);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(now);
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  return { time: `${time} IST`, date, isOpen: isWeekday && minutes >= 555 && minutes <= 930 };
}

function formatBreadth(data: RadarResponse | null) {
  if (!data) return "checking";
  if (typeof data.marketRegime.breadthPct === "number") return `${Math.round(data.marketRegime.breadthPct)}%`;
  return `${data.summary.long}L/${data.summary.short}S`;
}

function formatPrice(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return formatNumber(value, value >= 1000 ? 2 : 2);
}

function formatSigned(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function biasBadge(bias: Bias) {
  if (bias === "LONG") return "bg-profit-bg text-profit";
  if (bias === "SHORT") return "bg-loss-bg text-loss";
  return "bg-surface-hover text-muted";
}

function verdictBadge(verdict: Verdict) {
  if (verdict === "TRADE") return "bg-profit-bg text-profit";
  if (verdict === "WAIT") return "bg-warning/10 text-warning";
  return "bg-loss-bg text-loss";
}

function verdictScoreClass(verdict: Verdict) {
  if (verdict === "TRADE") return "border-profit/30 bg-profit-bg text-profit";
  if (verdict === "WAIT") return "border-warning/30 bg-warning/10 text-warning";
  return "border-loss/30 bg-loss-bg text-loss";
}

function verdictDot(verdict: Verdict) {
  if (verdict === "TRADE") return "bg-profit";
  if (verdict === "WAIT") return "bg-warning";
  return "bg-loss";
}

function scoreTone(candidate: RadarCandidate) {
  if (candidate.score >= 78) return candidate.bias === "SHORT" ? "text-loss" : "text-profit";
  if (candidate.score >= 55) return "text-warning";
  return "text-loss";
}

function signedTone(value?: number | null) {
  if (value == null || value === 0) return "text-muted";
  return value > 0 ? "text-profit" : "text-loss";
}

function toneText(tone: Tone) {
  if (tone === "profit") return "text-profit";
  if (tone === "warning") return "text-warning";
  if (tone === "loss") return "text-loss";
  if (tone === "accent") return "text-accent";
  return "text-muted";
}

function toneSoftBg(tone: Tone) {
  if (tone === "profit") return "bg-profit-bg";
  if (tone === "warning") return "bg-warning/10";
  if (tone === "loss") return "bg-loss-bg";
  if (tone === "accent") return "bg-accent-bg";
  return "bg-surface-hover";
}
