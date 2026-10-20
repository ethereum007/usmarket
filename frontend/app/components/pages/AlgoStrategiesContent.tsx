"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Gauge,
  LineChart,
  Lock,
  ShieldCheck,
  Target,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { deleteAPI, fetchAPI, postAPI } from "../../lib/api";

type AlgoMode = "paper" | "preview" | "disabled";
type StrategyId = "orb-vwap" | "pdh-cpr" | "oi-shift" | "vp-reclaim" | "abnormal-swing" | "sector-basket";

type StrategyPack = {
  id: StrategyId;
  name: string;
  shortName: string;
  family: "Intraday" | "Options" | "Swing" | "Basket";
  timeframe: string;
  universe: string;
  edge: string;
  trigger: string;
  stop: string;
  target: string;
  icon: LucideIcon;
  score: number;
  readiness: "Ready for paper" | "Needs live depth" | "Research mode";
  gates: string[];
  controls: string[];
  avoid: string[];
  sampleTrade: { entry: number; stop: number; target: number };
  metrics: { label: string; value: string; tone?: "good" | "warn" | "bad" | "neutral" }[];
};

type PaperRun = {
  strategyId: StrategyId;
  symbol: string;
  date: string;
  side: "LONG" | "SHORT";
  entry: number;
  exit: number | null;
  r: number;
  status: "Closed" | "Open" | "Skipped";
  note: string;
};

type StagedTicket = {
  id: string;
  strategyId: StrategyId;
  strategyName: string;
  route: string;
  side: string;
  product: string;
  quantity: number;
  limitPrice: number;
  stop: number;
  target: number;
  exposure: number;
  maxLoss: number;
  riskReward: number;
  mode: AlgoMode;
  stagedAt: string;
};

type PaperWatch = {
  id: string;
  strategyId: StrategyId;
  strategyName: string;
  side: string;
  quantity: number;
  entry: number;
  stop: number;
  target: number;
  exposure: number;
  maxLoss: number;
  riskReward: number;
  status: "Watching" | "Closed" | "Skipped";
  startedAt: string;
  syncStatus?: "local" | "syncing" | "synced" | "failed";
  syncError?: string;
  outcome?: "WIN" | "LOSS" | "SKIP";
  exit?: number | null;
  realizedR?: number | null;
};

type PaperWatchesResponse = {
  success: boolean;
  count: number;
  paperWatches: RawPaperWatch[];
};

type PaperWatchCreateResponse = {
  success: boolean;
  paperWatch: RawPaperWatch;
};

type PaperWatchOutcomeResponse = {
  success: boolean;
  paperWatch: RawPaperWatch;
  performance?: StrategyPerformance;
};

type RawPaperWatch = Partial<PaperWatch> & {
  strategyId?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
};

type AlgoPerformanceResponse = {
  success: boolean;
  asOf: string;
  summary: {
    paperWatches: number;
    resolved: number;
    winRatePct: number;
    totalR: number;
    promotionReady: number;
  };
  strategies: StrategyPerformance[];
};

type StrategyPerformance = {
  strategyId: string;
  strategyName: string;
  paperWatches: number;
  resolved: number;
  skipped: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgR: number;
  totalR: number;
  maxDrawdownR: number;
  promotionChecks: Record<"paperFires" | "winRate" | "avgR" | "drawdown", boolean>;
  promotionReady: boolean;
  promotionCriteria?: {
    minPaperFires?: number;
    minWinRatePct?: number;
    minAvgR?: number;
    maxSampleDrawdownR?: number;
  };
};

type ValidationCheck = {
  label: string;
  value: string;
  tone: "good" | "warn" | "bad" | "neutral";
  blocking?: boolean;
};

const MODE_OPTIONS: { key: AlgoMode; label: string; note: string }[] = [
  { key: "paper", label: "Paper", note: "Track signals only" },
  { key: "preview", label: "Order Preview", note: "Manual confirm" },
  { key: "disabled", label: "Live Disabled", note: "Guarded rollout" },
];

const STRATEGIES: StrategyPack[] = [
  {
    id: "orb-vwap",
    name: "Opening Range + VWAP",
    shortName: "ORB VWAP",
    family: "Intraday",
    timeframe: "9:15-10:45 IST",
    universe: "Nifty 50, Nifty 100, F&O liquid stocks",
    edge: "First clean expansion after the opening auction noise settles.",
    trigger: "15m/30m range break with price above VWAP, RVOL > 1.5x, and spread inside limit.",
    stop: "Below VWAP or opening range midpoint.",
    target: "1.5R first scale, trail above VWAP.",
    icon: Activity,
    score: 92,
    readiness: "Ready for paper",
    gates: ["Market breadth aligned", "RVOL confirmed", "Spread inside cap", "No first-candle chase"],
    controls: ["Max 2 trades per symbol", "Skip after 11:15 if no follow-through", "Auto-flat before close"],
    avoid: ["Gap already > 4%", "Low quote coverage", "One-sided depth missing"],
    sampleTrade: { entry: 1240, stop: 1224, target: 1272 },
    metrics: [
      { label: "Slippage sensitivity", value: "Medium", tone: "warn" },
      { label: "Best market", value: "Trending open", tone: "good" },
      { label: "Automation level", value: "Paper-ready", tone: "good" },
    ],
  },
  {
    id: "pdh-cpr",
    name: "PDH/PDL + CPR Drive",
    shortName: "PDH CPR",
    family: "Intraday",
    timeframe: "9:30-14:30 IST",
    universe: "Index leaders, high-volume cash names",
    edge: "Directional continuation when previous-day levels and CPR regime agree.",
    trigger: "PDH break above bullish CPR or PDL break below bearish CPR with sector confirmation.",
    stop: "Back inside PDH/PDL or CPR pivot failure.",
    target: "Prior swing extension or 2R.",
    icon: Target,
    score: 89,
    readiness: "Ready for paper",
    gates: ["CPR bias aligned", "Sector not fighting trade", "Volume expansion", "No nearby circuit risk"],
    controls: ["One retest entry only", "Position size from invalidation", "Skip if spread widens after trigger"],
    avoid: ["Range-bound index", "Fake breakout below 0.8x RVOL", "News spike without depth"],
    sampleTrade: { entry: 1865, stop: 1842, target: 1911 },
    metrics: [
      { label: "Slippage sensitivity", value: "Low", tone: "good" },
      { label: "Best market", value: "Directional day", tone: "good" },
      { label: "Automation level", value: "Paper-ready", tone: "good" },
    ],
  },
  {
    id: "oi-shift",
    name: "OI Shift Directional",
    shortName: "OI Shift",
    family: "Options",
    timeframe: "9:45-15:00 IST",
    universe: "NIFTY, BANKNIFTY, FINNIFTY",
    edge: "Directional bias when spot, OI change, PCR slope, and max-pain drift line up.",
    trigger: "Spot crosses key strike with put writing for longs or call writing for shorts.",
    stop: "Spot returns under trigger strike or OI support flips.",
    target: "Next OI wall or max-pain drift zone.",
    icon: BarChart3,
    score: 86,
    readiness: "Needs live depth",
    gates: ["OI change slope confirmed", "PCR not extreme", "IV not spiking against entry", "Depth supports direction"],
    controls: ["Index-only first", "No naked option selling", "Manual order preview required"],
    avoid: ["Event expiry whipsaw", "Wide bid/ask options", "Max pain pinned market"],
    sampleTrade: { entry: 24250, stop: 24180, target: 24390 },
    metrics: [
      { label: "Slippage sensitivity", value: "High", tone: "bad" },
      { label: "Best market", value: "Index trend", tone: "good" },
      { label: "Automation level", value: "Preview only", tone: "warn" },
    ],
  },
  {
    id: "vp-reclaim",
    name: "Volume Profile Reclaim",
    shortName: "VP Reclaim",
    family: "Intraday",
    timeframe: "10:00-14:45 IST",
    universe: "Liquid cash and F&O names",
    edge: "Trade from value-area acceptance instead of chasing candles.",
    trigger: "Price reclaims VAL/POC/VAH with RVOL and holds for confirmation candle.",
    stop: "Failed acceptance back below reclaimed level.",
    target: "Next value boundary or prior session imbalance.",
    icon: Gauge,
    score: 84,
    readiness: "Ready for paper",
    gates: ["POC/VAH/VAL available", "CPR confluence", "Spread inside cap", "No low-volume reclaim"],
    controls: ["Wait for close above level", "Trade only first reclaim", "Size by level distance"],
    avoid: ["Thin volume profile", "Late-day drift", "Low liquidity buckets"],
    sampleTrade: { entry: 760, stop: 748, target: 784 },
    metrics: [
      { label: "Slippage sensitivity", value: "Medium", tone: "warn" },
      { label: "Best market", value: "Mean-to-trend shift", tone: "good" },
      { label: "Automation level", value: "Paper-ready", tone: "good" },
    ],
  },
  {
    id: "abnormal-swing",
    name: "Abnormal Momentum Swing",
    shortName: "Abnormal Swing",
    family: "Swing",
    timeframe: "1-10 sessions",
    universe: "NSE/BSE liquid small, mid, large caps",
    edge: "Unusual price-volume-delivery moves filtered for clean liquidity and surveillance risk.",
    trigger: "Alpha Radar score > 8 with breakout, delivery strength, and sector support.",
    stop: "Invalidation below breakout base or prior demand zone.",
    target: "Measured move, 52W zone, or 2.5R.",
    icon: TrendingUp,
    score: 88,
    readiness: "Research mode",
    gates: ["Delivery strength", "No ASM/GSM/trade-to-trade", "Liquidity score passes", "No circuit-only move"],
    controls: ["No market orders", "Max portfolio heat", "Gap-risk sizing haircut"],
    avoid: ["Operator-looking illiquids", "Circuit stacks", "News-only spike"],
    sampleTrade: { entry: 438, stop: 414, target: 498 },
    metrics: [
      { label: "Slippage sensitivity", value: "Medium", tone: "warn" },
      { label: "Best market", value: "Momentum tape", tone: "good" },
      { label: "Automation level", value: "Research", tone: "neutral" },
    ],
  },
  {
    id: "sector-basket",
    name: "Sector Rotation Basket",
    shortName: "Rotation Basket",
    family: "Basket",
    timeframe: "2-20 sessions",
    universe: "Sector leaders and ETFs where available",
    edge: "Buy strength when sector breadth, RRG rotation, and leader momentum agree.",
    trigger: "Sector enters leading/improving with top-ranked liquid names breaking relative strength.",
    stop: "Sector falls back below benchmark-relative threshold.",
    target: "Basket rebalance by rank decay or 3R.",
    icon: LineChart,
    score: 81,
    readiness: "Research mode",
    gates: ["RRG direction", "Breadth positive", "Leader concentration", "Index regime not hostile"],
    controls: ["Equal-risk basket", "Rebalance weekly", "Cap single-sector exposure"],
    avoid: ["Crowded expiry week", "Weak benchmark", "Low constituent breadth"],
    sampleTrade: { entry: 980, stop: 940, target: 1060 },
    metrics: [
      { label: "Slippage sensitivity", value: "Low", tone: "good" },
      { label: "Best market", value: "Rotational bull", tone: "good" },
      { label: "Automation level", value: "Research", tone: "neutral" },
    ],
  },
];

const EXECUTION_GATES: { label: string; value: string; tone: "good" | "warn" | "bad" | "neutral" }[] = [
  { label: "Paper trading first", value: "Required", tone: "good" },
  { label: "Broker order preview", value: "Manual confirm", tone: "warn" },
  { label: "Live auto-execution", value: "Disabled", tone: "bad" },
  { label: "Audit trail", value: "Every signal", tone: "good" },
];

const STAGED_TICKETS_STORAGE_KEY = "alpha-radar.algo-lab.staged-tickets";
const PAPER_WATCHES_STORAGE_KEY = "alpha-radar.algo-lab.paper-watches";

const PAPER_RUNS: PaperRun[] = [
  { strategyId: "orb-vwap", symbol: "SBIN", date: "Today", side: "LONG", entry: 812.4, exit: 826.8, r: 1.8, status: "Closed", note: "VWAP hold after first pullback" },
  { strategyId: "orb-vwap", symbol: "RELIANCE", date: "Today", side: "LONG", entry: 1456.2, exit: null, r: 0.4, status: "Open", note: "Range break, volume fading" },
  { strategyId: "orb-vwap", symbol: "TCS", date: "Prev", side: "SHORT", entry: 3868, exit: 3844, r: 1.2, status: "Closed", note: "Rejected VWAP twice" },
  { strategyId: "pdh-cpr", symbol: "HDFCBANK", date: "Today", side: "LONG", entry: 1718, exit: 1749, r: 1.5, status: "Closed", note: "PDH retest with CPR support" },
  { strategyId: "pdh-cpr", symbol: "LT", date: "Prev", side: "SHORT", entry: 3672, exit: 3658, r: 0.6, status: "Closed", note: "Weak follow-through after PDL break" },
  { strategyId: "oi-shift", symbol: "NIFTY", date: "Today", side: "LONG", entry: 24250, exit: null, r: 0.2, status: "Open", note: "Put writing building at ATM" },
  { strategyId: "oi-shift", symbol: "BANKNIFTY", date: "Prev", side: "SHORT", entry: 51880, exit: 51640, r: 1.4, status: "Closed", note: "Call writing led below key strike" },
  { strategyId: "vp-reclaim", symbol: "ICICIBANK", date: "Today", side: "LONG", entry: 1128, exit: 1146, r: 1.5, status: "Closed", note: "POC reclaim with spread inside cap" },
  { strategyId: "vp-reclaim", symbol: "AXISBANK", date: "Prev", side: "LONG", entry: 1182, exit: 1176, r: -0.5, status: "Closed", note: "Failed VAH acceptance" },
  { strategyId: "abnormal-swing", symbol: "NETWEB", date: "Today", side: "LONG", entry: 2350, exit: null, r: 1.1, status: "Open", note: "High RVOL and delivery follow-through" },
  { strategyId: "abnormal-swing", symbol: "ANANTRAJ", date: "Prev", side: "LONG", entry: 512, exit: 536, r: 1, status: "Closed", note: "Clean momentum, no circuit stack" },
  { strategyId: "sector-basket", symbol: "REALTY", date: "Today", side: "LONG", entry: 100, exit: null, r: 0.7, status: "Open", note: "Sector breadth improving" },
  { strategyId: "sector-basket", symbol: "PHARMA", date: "Prev", side: "LONG", entry: 100, exit: 101.8, r: 0.9, status: "Closed", note: "Rotation still constructive" },
];

export default function AlgoStrategiesContent() {
  const [selectedId, setSelectedId] = useState<StrategyId>("orb-vwap");
  const [mode, setMode] = useState<AlgoMode>("paper");
  const selected = useMemo(
    () => STRATEGIES.find((strategy) => strategy.id === selectedId) ?? STRATEGIES[0],
    [selectedId]
  );

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="flex flex-col gap-3 border-b border-card-border pb-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Algo Lab</div>
              <h2 className="mt-1 text-xl font-bold text-text-heading">Strategy packs for India-first traders</h2>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">
                Paper-mode systems built from Alpha Radar signals, Arrow/Kite data rails, risk gates, and manual order preview.
              </p>
            </div>
            <div className="flex rounded-lg border border-card-border bg-page-bg p-1">
              {MODE_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setMode(option.key)}
                  className={[
                    "rounded-md px-3 py-2 text-left text-xs transition-colors",
                    mode === option.key ? "bg-accent text-white" : "text-muted hover:text-text-heading",
                  ].join(" ")}
                >
                  <div className="font-bold">{option.label}</div>
                  <div className={mode === option.key ? "text-white/75" : "text-muted"}>{option.note}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {STRATEGIES.map((strategy) => (
              <StrategyCard
                key={strategy.id}
                strategy={strategy}
                active={strategy.id === selected.id}
                onSelect={() => setSelectedId(strategy.id)}
              />
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Execution Guardrails</div>
              <h3 className="mt-1 text-lg font-bold text-text-heading">No blind auto-trading</h3>
            </div>
            <ShieldCheck className="h-5 w-5 text-accent" aria-hidden="true" />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {EXECUTION_GATES.map((gate) => (
              <div key={gate.label} className="rounded-lg border border-card-border bg-page-bg/70 p-3">
                <div className="text-[11px] text-muted">{gate.label}</div>
                <div className={["mt-1 text-sm font-bold", toneClass(gate.tone)].join(" ")}>{gate.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-warning/25 bg-warning/10 p-3">
            <div className="flex items-center gap-2 text-sm font-bold text-warning">
              <Lock className="h-4 w-4" aria-hidden="true" />
              Live execution locked
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              Strategy automation should ship in this order: paper results, order preview, risk approval, broker approval, then opt-in live routing.
            </p>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-xl border border-card-border bg-card p-4">
          <SelectedStrategy strategy={selected} mode={mode} />
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <RiskAndPreview strategy={selected} mode={mode} />
        </div>
      </section>

      <PaperLedger strategy={selected} />
    </div>
  );
}

function StrategyCard({
  strategy,
  active,
  onSelect,
}: {
  strategy: StrategyPack;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = strategy.icon;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "rounded-xl border p-3 text-left transition-all",
        active ? "border-accent bg-accent-bg shadow-sm" : "border-card-border bg-page-bg/40 hover:border-accent/40",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={["rounded-lg p-2", active ? "bg-accent text-white" : "bg-card text-accent"].join(" ")}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <div className="text-sm font-bold text-text-heading">{strategy.shortName}</div>
            <div className="text-[11px] text-muted">{strategy.family}</div>
          </div>
        </div>
        <div className={["text-lg font-extrabold", strategy.score >= 88 ? "text-profit" : "text-warning"].join(" ")}>
          {strategy.score}
        </div>
      </div>
      <div className="mt-3 text-xs leading-relaxed text-text-secondary">{strategy.edge}</div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge>{strategy.timeframe}</Badge>
        <Badge tone={strategy.readiness === "Ready for paper" ? "good" : "warn"}>{strategy.readiness}</Badge>
      </div>
    </button>
  );
}

function SelectedStrategy({ strategy, mode }: { strategy: StrategyPack; mode: AlgoMode }) {
  const Icon = strategy.icon;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 border-b border-card-border pb-4">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-accent-bg p-3 text-accent">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">{strategy.family} Strategy</div>
            <h3 className="text-xl font-bold text-text-heading">{strategy.name}</h3>
          </div>
        </div>
        <Badge tone={mode === "paper" ? "good" : mode === "preview" ? "warn" : "bad"}>{modeLabel(mode)}</Badge>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {strategy.metrics.map((metric) => (
          <div key={metric.label} className="rounded-lg bg-page-bg/70 p-3">
            <div className="text-[11px] text-muted">{metric.label}</div>
            <div className={["mt-1 text-sm font-bold", toneClass(metric.tone ?? "neutral")].join(" ")}>
              {metric.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <InfoBlock title="Trigger" value={strategy.trigger} />
        <InfoBlock title="Invalidation" value={strategy.stop} />
        <InfoBlock title="Profit Logic" value={strategy.target} />
        <InfoBlock title="Universe" value={strategy.universe} />
      </div>
    </div>
  );
}

function RiskAndPreview({ strategy, mode }: { strategy: StrategyPack; mode: AlgoMode }) {
  const [capital, setCapital] = useState(500000);
  const [riskPct, setRiskPct] = useState(0.5);
  const [entry, setEntry] = useState(strategy.sampleTrade.entry);
  const [stop, setStop] = useState(strategy.sampleTrade.stop);
  const [target, setTarget] = useState(strategy.sampleTrade.target);
  const [ticketStaged, setTicketStaged] = useState(false);
  const [payloadCopied, setPayloadCopied] = useState(false);
  const [stagedTickets, setStagedTickets] = useState<StagedTicket[]>([]);
  const [ticketsHydrated, setTicketsHydrated] = useState(false);
  const [paperWatches, setPaperWatches] = useState<PaperWatch[]>([]);
  const [watchesHydrated, setWatchesHydrated] = useState(false);
  const [paperWatchStarted, setPaperWatchStarted] = useState(false);
  const [watchSyncMessage, setWatchSyncMessage] = useState<string | null>(null);
  const [algoPerformance, setAlgoPerformance] = useState<AlgoPerformanceResponse | null>(null);
  const [performanceMessage, setPerformanceMessage] = useState<string | null>(null);
  const [outcomePendingId, setOutcomePendingId] = useState<string | null>(null);

  const refreshAlgoPerformance = useCallback(async () => {
    try {
      const response = await fetchAPI<AlgoPerformanceResponse>("/api/algos/performance");
      setAlgoPerformance(response);
      setPerformanceMessage(null);
    } catch (error: unknown) {
      setPerformanceMessage(`Performance ledger unavailable: ${shortApiError(error)}`);
    }
  }, []);

  useEffect(() => {
    setEntry(strategy.sampleTrade.entry);
    setStop(strategy.sampleTrade.stop);
    setTarget(strategy.sampleTrade.target);
    setTicketStaged(false);
    setPaperWatchStarted(false);
    setWatchSyncMessage(null);
  }, [strategy]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STAGED_TICKETS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StagedTicket[];
        if (Array.isArray(parsed)) {
          setStagedTickets(parsed.slice(0, 8));
        }
      }
    } catch {
      setStagedTickets([]);
    } finally {
      setTicketsHydrated(true);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PAPER_WATCHES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PaperWatch[];
        if (Array.isArray(parsed)) {
          setPaperWatches(parsed.slice(0, 12));
        }
      }
    } catch {
      setPaperWatches([]);
    } finally {
      setWatchesHydrated(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAPI<PaperWatchesResponse>("/api/algos/paper-watches")
      .then((response) => {
        if (cancelled || !Array.isArray(response.paperWatches)) return;
        const serverWatches = response.paperWatches
          .map(normalizePaperWatch)
          .filter((watch): watch is PaperWatch => Boolean(watch));
        if (serverWatches.length === 0) return;
        setPaperWatches((current) => mergePaperWatches(serverWatches, current).slice(0, 12));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWatchSyncMessage(`Local watch mode. Backend sync unavailable: ${shortApiError(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshAlgoPerformance();
  }, [refreshAlgoPerformance]);

  useEffect(() => {
    if (!ticketsHydrated) return;
    window.localStorage.setItem(STAGED_TICKETS_STORAGE_KEY, JSON.stringify(stagedTickets.slice(0, 8)));
  }, [stagedTickets, ticketsHydrated]);

  useEffect(() => {
    if (!watchesHydrated) return;
    window.localStorage.setItem(PAPER_WATCHES_STORAGE_KEY, JSON.stringify(paperWatches.slice(0, 12)));
  }, [paperWatches, watchesHydrated]);

  const sizing = useMemo(() => {
    const riskBudget = Math.max(0, capital * (riskPct / 100));
    const perShareRisk = Math.abs(entry - stop);
    const rewardPerShare = Math.abs(target - entry);
    const qty = perShareRisk > 0 ? Math.floor(riskBudget / perShareRisk) : 0;
    const exposure = qty * entry;
    const maxLoss = qty * perShareRisk;
    const targetProfit = qty * rewardPerShare;
    const rr = perShareRisk > 0 ? rewardPerShare / perShareRisk : 0;

    return { riskBudget, perShareRisk, qty, exposure, maxLoss, targetProfit, rr };
  }, [capital, entry, riskPct, stop, target]);

  useEffect(() => {
    setTicketStaged(false);
    setPaperWatchStarted(false);
    setWatchSyncMessage(null);
  }, [entry, mode, sizing.qty, stop, strategy.id, target]);

  const ticket = useMemo(() => {
    const side = target >= entry ? "BUY" : "SELL";
    const product = strategy.family === "Swing" || strategy.family === "Basket" ? "CNC / Delivery" : "MIS / Intraday";
    const route = strategy.family === "Options" ? "Arrow options route" : "Arrow first, Kite fallback";
    const slippageCap = strategy.family === "Options" ? "0.35%" : strategy.family === "Swing" ? "0.25%" : "0.15%";

    return {
      route,
      side,
      product,
      quantity: sizing.qty,
      orderType: "LIMIT",
      validity: "DAY",
      limitPrice: entry,
      stop,
      target,
      slippageCap,
    };
  }, [entry, sizing.qty, stop, strategy.family, target]);

  const validationChecks = useMemo<ValidationCheck[]>(() => {
    const exposureLimit = strategy.family === "Swing" || strategy.family === "Basket" ? capital : capital * 2;
    return [
      {
        label: "Risk distance",
        value: sizing.perShareRisk > 0 ? `${formatPrice(sizing.perShareRisk)} / share` : "Invalid stop",
        tone: sizing.perShareRisk > 0 ? "good" : "bad",
        blocking: sizing.perShareRisk <= 0,
      },
      {
        label: "Reward/Risk",
        value: `${formatNumber(sizing.rr, 2)}R`,
        tone: sizing.rr >= 1.5 ? "good" : sizing.rr >= 1 ? "warn" : "bad",
        blocking: sizing.rr < 1,
      },
      {
        label: "Order size",
        value: sizing.qty > 0 ? `${sizing.qty.toLocaleString("en-IN")} qty` : "No size",
        tone: sizing.qty > 0 ? "good" : "bad",
        blocking: sizing.qty <= 0,
      },
      {
        label: "Exposure cap",
        value: `${formatCurrency(sizing.exposure)} / ${formatCurrency(exposureLimit)}`,
        tone: sizing.exposure <= exposureLimit ? "good" : "bad",
        blocking: sizing.exposure > exposureLimit,
      },
      {
        label: "Execution mode",
        value: mode === "disabled" ? "Live locked" : modeLabel(mode),
        tone: mode === "disabled" ? "bad" : "good",
        blocking: mode === "disabled",
      },
    ];
  }, [capital, mode, sizing.exposure, sizing.perShareRisk, sizing.qty, sizing.rr, strategy.family]);

  const blockingChecks = useMemo(() => validationChecks.filter((check) => check.blocking), [validationChecks]);
  const canStageTicket = blockingChecks.length === 0;
  const visibleTickets = stagedTickets.filter((item) => item.strategyId === strategy.id);
  const visibleWatches = paperWatches.filter((item) => item.strategyId === strategy.id);
  const currentPerformance = algoPerformance?.strategies.find((item) => item.strategyId === strategy.id) ?? null;
  const orderPayload = useMemo(() => ({
    schemaVersion: "alpha-radar.algo-ticket.v1",
    generatedAt: "on-copy-or-download",
    mode,
    strategy: {
      id: strategy.id,
      name: strategy.name,
      family: strategy.family,
      timeframe: strategy.timeframe,
      readiness: strategy.readiness,
    },
    routing: {
      route: ticket.route,
      preferredProvider: strategy.family === "Options" ? "arrow" : "arrow_first",
      fallbackProvider: strategy.family === "Options" ? null : "kite",
      liveExecutionAllowed: false,
    },
    order: {
      side: ticket.side,
      product: ticket.product,
      orderType: ticket.orderType,
      validity: ticket.validity,
      quantity: ticket.quantity,
      limitPrice: ticket.limitPrice,
      stopLossPrice: ticket.stop,
      targetPrice: ticket.target,
    },
    risk: {
      capital,
      riskPct,
      riskBudget: sizing.riskBudget,
      perShareRisk: sizing.perShareRisk,
      exposure: sizing.exposure,
      maxLoss: sizing.maxLoss,
      targetProfit: sizing.targetProfit,
      riskReward: sizing.rr,
      slippageCap: ticket.slippageCap,
    },
    validation: {
      stageable: canStageTicket,
      blockingChecks: blockingChecks.map((check) => check.label),
      checks: validationChecks.map(({ label, value, tone, blocking }) => ({ label, value, tone, blocking: Boolean(blocking) })),
    },
    guardrails: {
      mustPass: strategy.gates,
      controls: strategy.controls,
      avoid: strategy.avoid,
    },
  }), [
    blockingChecks,
    canStageTicket,
    capital,
    mode,
    riskPct,
    sizing.exposure,
    sizing.maxLoss,
    sizing.perShareRisk,
    sizing.riskBudget,
    sizing.rr,
    sizing.targetProfit,
    strategy,
    ticket,
    validationChecks,
  ]);
  const orderPayloadJson = useMemo(() => JSON.stringify(orderPayload, null, 2), [orderPayload]);

  useEffect(() => {
    setPayloadCopied(false);
  }, [orderPayloadJson]);

  function handleStageTicket() {
    if (!canStageTicket) return;
    setTicketStaged(true);
    setStagedTickets((current) => [
      {
        id: `${strategy.id}-${Date.now()}`,
        strategyId: strategy.id,
        strategyName: strategy.shortName,
        route: ticket.route,
        side: ticket.side,
        product: ticket.product,
        quantity: ticket.quantity,
        limitPrice: ticket.limitPrice,
        stop: ticket.stop,
        target: ticket.target,
        exposure: sizing.exposure,
        maxLoss: sizing.maxLoss,
        riskReward: sizing.rr,
        mode,
        stagedAt: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      },
      ...current,
    ].slice(0, 8));
  }

  function handleClearTickets() {
    setStagedTickets((current) => current.filter((item) => item.strategyId !== strategy.id));
    setTicketStaged(false);
  }

  async function handleStartPaperWatch() {
    if (!canStageTicket || paperWatchStarted) return;
    setPaperWatchStarted(true);
    setWatchSyncMessage("Syncing paper watch to backend validation ledger...");
    const watch: PaperWatch = {
      id: `${strategy.id}-watch-${Date.now()}`,
      strategyId: strategy.id,
      strategyName: strategy.shortName,
      side: ticket.side,
      quantity: ticket.quantity,
      entry: ticket.limitPrice,
      stop: ticket.stop,
      target: ticket.target,
      exposure: sizing.exposure,
      maxLoss: sizing.maxLoss,
      riskReward: sizing.rr,
      status: "Watching",
      syncStatus: "syncing",
      startedAt: new Date().toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    setPaperWatches((current) => [watch, ...current].slice(0, 12));

    try {
      const response = await postAPI<PaperWatchCreateResponse>("/api/algos/paper-watches", {
        id: watch.id,
        strategyId: watch.strategyId,
        strategyName: watch.strategyName,
        side: watch.side,
        quantity: watch.quantity,
        entry: watch.entry,
        stop: watch.stop,
        target: watch.target,
        exposure: watch.exposure,
        maxLoss: watch.maxLoss,
        riskReward: watch.riskReward,
        source: "algo-lab",
        payload: toStampedPayload(orderPayload),
      });
      const syncedWatch = normalizePaperWatch(response.paperWatch) ?? { ...watch, syncStatus: "synced" as const };
      setPaperWatches((current) => mergePaperWatches([syncedWatch], current).slice(0, 12));
      setWatchSyncMessage("Paper watch synced to backend validation ledger.");
      void refreshAlgoPerformance();
    } catch (error: unknown) {
      const message = shortApiError(error);
      setPaperWatches((current) =>
        current.map((item) =>
          item.id === watch.id ? { ...item, syncStatus: "failed", syncError: message } : item,
        ),
      );
      setWatchSyncMessage(`Saved locally; backend sync failed: ${message}`);
    }
  }

  async function handleRecordOutcome(watch: PaperWatch, outcome: "WIN" | "LOSS" | "SKIP") {
    if (watch.syncStatus !== "synced" || watch.status !== "Watching") return;
    setOutcomePendingId(`${watch.id}:${outcome}`);
    setWatchSyncMessage(`Recording ${outcome} outcome for ${watch.strategyName}...`);
    try {
      const body =
        outcome === "SKIP"
          ? { outcome, note: "Manual skip from Algo Lab" }
          : { outcome, realizedR: outcome === "WIN" ? 1 : -1, note: "Manual quick outcome from Algo Lab" };
      const response = await postAPI<PaperWatchOutcomeResponse>(
        `/api/algos/paper-watches/${encodeURIComponent(watch.id)}/outcome`,
        body,
      );
      const updatedWatch = normalizePaperWatch(response.paperWatch);
      if (updatedWatch) {
        setPaperWatches((current) => mergePaperWatches([updatedWatch], current).slice(0, 12));
      }
      setWatchSyncMessage(`${outcome} recorded. Algo performance ledger refreshed.`);
      await refreshAlgoPerformance();
    } catch (error: unknown) {
      setWatchSyncMessage(`Outcome save failed: ${shortApiError(error)}`);
    } finally {
      setOutcomePendingId(null);
    }
  }

  async function handleNextAction() {
    if (mode === "paper") {
      await handleStartPaperWatch();
      return;
    }
    if (mode === "preview") {
      handleStageTicket();
    }
  }

  async function handleClearWatches() {
    const syncedWatchIds = visibleWatches
      .filter((item) => item.syncStatus === "synced")
      .map((item) => item.id);
    setPaperWatches((current) => current.filter((item) => item.strategyId !== strategy.id));
    setPaperWatchStarted(false);
    setWatchSyncMessage("Paper watches cleared from this strategy view.");
    if (syncedWatchIds.length === 0) return;

    const results = await Promise.allSettled(
      syncedWatchIds.map((watchId) => deleteAPI(`/api/algos/paper-watches/${encodeURIComponent(watchId)}`)),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      setWatchSyncMessage(`Cleared locally; ${failed} backend watch delete${failed === 1 ? "" : "s"} need retry.`);
    } else {
      void refreshAlgoPerformance();
    }
  }

  async function handleCopyPayload() {
    try {
      await navigator.clipboard.writeText(toStampedJson(orderPayload));
      setPayloadCopied(true);
    } catch {
      downloadJson(`alpha-radar-${strategy.id}-order-payload.json`, orderPayload);
    }
  }

  function handleDownloadPayload() {
    downloadJson(`alpha-radar-${strategy.id}-order-payload.json`, orderPayload);
  }

  return (
    <div>
      <div className="flex flex-col gap-2 border-b border-card-border pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Trade Readiness</div>
          <h3 className="mt-1 text-lg font-bold text-text-heading">Gates before any order</h3>
        </div>
        <div className="rounded-lg bg-page-bg/70 px-3 py-2 text-xs">
          <span className="font-semibold text-text-heading">{strategy.readiness}</span>
          <span className="ml-2 text-muted">current state</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Checklist title="Must Pass" items={strategy.gates} icon={CheckCircle2} tone="good" />
        <Checklist title="Controls" items={strategy.controls} icon={ShieldCheck} tone="warn" />
        <Checklist title="Avoid" items={strategy.avoid} icon={Lock} tone="bad" />
      </div>

      <div className="mt-4 rounded-xl border border-card-border bg-page-bg/50 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-bold text-text-heading">Position sizing preview</div>
            <div className="mt-1 text-xs text-muted">Paper calculation only. Quantity uses entry, stop, and max risk.</div>
          </div>
          <Badge tone={sizing.rr >= 1.8 ? "good" : sizing.rr >= 1.2 ? "warn" : "bad"}>
            R/R {formatNumber(sizing.rr, 2)}
          </Badge>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <NumberField label="Capital" value={capital} min={0} step={10000} onChange={setCapital} />
          <NumberField label="Risk %" value={riskPct} min={0.1} step={0.1} onChange={setRiskPct} />
          <NumberField label="Entry" value={entry} min={0} step={0.05} onChange={setEntry} />
          <NumberField label="Stop" value={stop} min={0} step={0.05} onChange={setStop} />
          <NumberField label="Target" value={target} min={0} step={0.05} onChange={setTarget} />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <SizingMetric label="Qty" value={sizing.qty.toLocaleString("en-IN")} />
          <SizingMetric label="Exposure" value={formatCurrency(sizing.exposure)} />
          <SizingMetric label="Max Loss" value={formatCurrency(sizing.maxLoss)} tone="bad" />
          <SizingMetric label="Target P&L" value={formatCurrency(sizing.targetProfit)} tone="good" />
        </div>

        <div className="mt-4 rounded-lg border border-card-border bg-card p-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">Execution checks</div>
            <Badge tone={canStageTicket ? "good" : "bad"}>{canStageTicket ? "Stageable" : "Blocked"}</Badge>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {validationChecks.map((check) => (
              <SizingMetric key={check.label} label={check.label} value={check.value} tone={check.tone} />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-card-border bg-page-bg/50 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-bold text-text-heading">Example paper trades ledger</div>
            <div className="mt-1 text-xs text-muted">Promotion gates use synced paper outcomes only. Live execution stays locked.</div>
          </div>
          <Badge tone={currentPerformance?.promotionReady ? "good" : currentPerformance && currentPerformance.resolved > 0 ? "warn" : "neutral"}>
            {currentPerformance?.promotionReady ? "Promotion Ready" : currentPerformance && currentPerformance.resolved > 0 ? "Building Sample" : "No Outcomes"}
          </Badge>
        </div>

        {performanceMessage && (
          <div className="mt-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs font-semibold text-warning">
            {performanceMessage}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
          <SizingMetric label="Resolved" value={(currentPerformance?.resolved ?? 0).toLocaleString("en-IN")} />
          <SizingMetric
            label="Win Rate"
            value={`${formatNumber(currentPerformance?.winRatePct ?? 0, 1)}%`}
            tone={(currentPerformance?.winRatePct ?? 0) >= (currentPerformance?.promotionCriteria?.minWinRatePct ?? 52) ? "good" : "warn"}
          />
          <SizingMetric
            label="Avg R"
            value={`${formatSignedNumber(currentPerformance?.avgR ?? 0, 2)}R`}
            tone={(currentPerformance?.avgR ?? 0) >= (currentPerformance?.promotionCriteria?.minAvgR ?? 0.25) ? "good" : "warn"}
          />
          <SizingMetric
            label="Total R"
            value={`${formatSignedNumber(currentPerformance?.totalR ?? 0, 2)}R`}
            tone={(currentPerformance?.totalR ?? 0) > 0 ? "good" : "neutral"}
          />
          <SizingMetric
            label="Drawdown"
            value={`${formatNumber(currentPerformance?.maxDrawdownR ?? 0, 2)}R`}
            tone={(currentPerformance?.maxDrawdownR ?? 0) <= (currentPerformance?.promotionCriteria?.maxSampleDrawdownR ?? 6) ? "good" : "bad"}
          />
          <SizingMetric label="Skipped" value={(currentPerformance?.skipped ?? 0).toLocaleString("en-IN")} />
        </div>

        {currentPerformance && (
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {promotionCheckRows(currentPerformance).map((check) => (
              <div key={check.label} className="rounded-lg border border-card-border bg-card px-3 py-2">
                <div className="text-[11px] text-muted">{check.label}</div>
                <div className={["mt-1 text-xs font-bold", check.pass ? "text-profit" : "text-warning"].join(" ")}>
                  {check.pass ? "Passed" : check.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-card-border bg-page-bg/50 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-bold text-text-heading">Broker order preview</div>
            <div className="mt-1 text-xs text-muted">Staged locally only. No Arrow/Kite order is sent from this screen.</div>
          </div>
          <Badge tone={mode === "preview" ? "warn" : mode === "paper" ? "good" : "bad"}>
            {mode === "disabled" ? "Live locked" : mode === "preview" ? "Manual confirm" : "Paper ticket"}
          </Badge>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <TicketField label="Route" value={ticket.route} />
          <TicketField label="Side" value={ticket.side} tone={ticket.side === "BUY" ? "good" : "bad"} />
          <TicketField label="Product" value={ticket.product} />
          <TicketField label="Qty" value={ticket.quantity.toLocaleString("en-IN")} />
          <TicketField label="Order Type" value={ticket.orderType} />
          <TicketField label="Limit" value={formatPrice(ticket.limitPrice)} />
          <TicketField label="Stop" value={formatPrice(ticket.stop)} tone="bad" />
          <TicketField label="Target" value={formatPrice(ticket.target)} tone="good" />
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-card-border bg-card px-3 py-3 md:flex-row md:items-center md:justify-between">
          <div className="text-xs leading-relaxed text-text-secondary">
            Validity <span className="font-bold text-text-heading">{ticket.validity}</span>, slippage cap{" "}
            <span className="font-bold text-text-heading">{ticket.slippageCap}</span>, max loss{" "}
            <span className="font-bold text-loss">{formatCurrency(sizing.maxLoss)}</span>.
          </div>
          <button
            type="button"
            disabled={!canStageTicket}
            onClick={handleStageTicket}
            className={[
              "rounded-lg px-4 py-2 text-sm font-bold transition-colors",
              !canStageTicket
                ? "cursor-not-allowed bg-card-border/40 text-text-tertiary"
                : "bg-accent text-white hover:bg-accent/85",
            ].join(" ")}
          >
            {ticketStaged ? "Preview Staged" : mode === "preview" ? "Stage Order Preview" : "Stage Paper Ticket"}
          </button>
        </div>

        {!canStageTicket && (
          <div className="mt-3 rounded-lg border border-loss/20 bg-loss-bg px-3 py-2 text-xs font-semibold text-loss">
            Fix {blockingChecks.map((check) => check.label.toLowerCase()).join(", ")} before staging this preview.
          </div>
        )}

        {ticketStaged && (
          <div className="mt-3 rounded-lg border border-profit/20 bg-profit-bg px-3 py-2 text-xs font-semibold text-profit">
            Preview staged locally. Broker execution remains locked until explicit user confirmation and backend order routing are wired.
          </div>
        )}

        <details className="mt-4 rounded-lg border border-card-border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-bold text-text-heading">
            <span>Backend payload preview</span>
            <span className="text-muted">JSON for broker-routing tests</span>
          </summary>
          <div className="border-t border-card-border p-3">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs leading-relaxed text-muted">
                Local debug payload only. It is not posted to Arrow, Kite, or Alpha Radar backend from this screen.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCopyPayload}
                  className="rounded-md border border-card-border px-2.5 py-1 text-xs font-bold text-muted transition-colors hover:border-accent/40 hover:text-accent"
                >
                  {payloadCopied ? "Copied" : "Copy JSON"}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadPayload}
                  className="rounded-md border border-card-border px-2.5 py-1 text-xs font-bold text-muted transition-colors hover:border-accent/40 hover:text-accent"
                >
                  Download
                </button>
              </div>
            </div>
            <pre className="max-h-56 overflow-auto rounded-md bg-page-bg p-3 text-[11px] leading-relaxed text-text-secondary">
              {orderPayloadJson}
            </pre>
          </div>
        </details>

        {visibleTickets.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-semibold text-muted">
                {visibleTickets.length} staged preview{visibleTickets.length === 1 ? "" : "s"} for {strategy.shortName}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => exportStagedTicketsCsv(strategy, visibleTickets)}
                  className="rounded-md border border-card-border px-2.5 py-1 text-xs font-bold text-muted transition-colors hover:border-accent/40 hover:text-accent"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={handleClearTickets}
                  className="rounded-md border border-card-border px-2.5 py-1 text-xs font-bold text-muted transition-colors hover:border-loss/40 hover:text-loss"
                >
                  Clear
                </button>
              </div>
            </div>
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-muted">
                <tr className="border-b border-card-border">
                  <th className="px-3 py-2 font-bold">Time</th>
                  <th className="px-3 py-2 font-bold">Mode</th>
                  <th className="px-3 py-2 font-bold">Route</th>
                  <th className="px-3 py-2 font-bold">Side</th>
                  <th className="px-3 py-2 font-bold text-right">Qty</th>
                  <th className="px-3 py-2 font-bold text-right">Limit</th>
                  <th className="px-3 py-2 font-bold text-right">Stop</th>
                  <th className="px-3 py-2 font-bold text-right">Target</th>
                  <th className="px-3 py-2 font-bold text-right">R/R</th>
                  <th className="px-3 py-2 font-bold text-right">Exposure</th>
                  <th className="px-3 py-2 font-bold text-right">Max Loss</th>
                </tr>
              </thead>
              <tbody>
                {visibleTickets.map((item) => (
                  <tr key={item.id} className="border-b border-card-border/50 hover:bg-page-bg/50">
                    <td className="px-3 py-2 text-muted">{item.stagedAt}</td>
                    <td className="px-3 py-2">
                      <Badge tone={item.mode === "paper" ? "good" : "warn"}>{modeLabel(item.mode)}</Badge>
                    </td>
                    <td className="px-3 py-2 text-text-secondary">{item.route}</td>
                    <td className={["px-3 py-2 font-bold", item.side === "BUY" ? "text-profit" : "text-loss"].join(" ")}>{item.side}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{item.quantity.toLocaleString("en-IN")}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{formatPrice(item.limitPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono text-loss">{formatPrice(item.stop)}</td>
                    <td className="px-3 py-2 text-right font-mono text-profit">{formatPrice(item.target)}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{formatNumber(item.riskReward ?? 0, 2)}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{formatCurrency(item.exposure ?? 0)}</td>
                    <td className="px-3 py-2 text-right font-mono font-bold text-loss">{formatCurrency(item.maxLoss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-card-border bg-page-bg/50 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-bold text-text-heading">Next action</div>
            <div className="mt-1 text-xs leading-relaxed text-muted">{nextAction(strategy, mode)}</div>
          </div>
          <button
            type="button"
            disabled={mode === "disabled" || !canStageTicket || (mode === "paper" && paperWatchStarted)}
            onClick={handleNextAction}
            className={[
              "rounded-lg px-4 py-2 text-sm font-bold transition-colors",
              mode === "disabled" || !canStageTicket || (mode === "paper" && paperWatchStarted)
                ? "cursor-not-allowed bg-card-border/40 text-text-tertiary"
                : "bg-accent text-white hover:bg-accent/85",
            ].join(" ")}
          >
            {paperWatchStarted && mode === "paper" ? "Paper Watch Started" : mode === "paper" ? "Start Paper Watch" : mode === "preview" ? "Stage Preview" : "Live Locked"}
          </button>
        </div>

        {watchSyncMessage && mode === "paper" && (
          <div
            className={[
              "mt-3 rounded-lg border px-3 py-2 text-xs font-semibold",
              watchSyncMessage.includes("failed") || watchSyncMessage.includes("unavailable") || watchSyncMessage.includes("retry")
                ? "border-warning/25 bg-warning/10 text-warning"
                : "border-profit/20 bg-profit-bg text-profit",
            ].join(" ")}
          >
            {watchSyncMessage}
          </div>
        )}

        {visibleWatches.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-semibold text-muted">
                {visibleWatches.length} paper watch{visibleWatches.length === 1 ? "" : "es"} for {strategy.shortName}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => exportPaperWatchesCsv(strategy, visibleWatches)}
                  className="rounded-md border border-card-border px-2.5 py-1 text-xs font-bold text-muted transition-colors hover:border-accent/40 hover:text-accent"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={handleClearWatches}
                  className="rounded-md border border-card-border px-2.5 py-1 text-xs font-bold text-muted transition-colors hover:border-loss/40 hover:text-loss"
                >
                  Clear
                </button>
              </div>
            </div>
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-muted">
                <tr className="border-b border-card-border">
                  <th className="px-3 py-2 font-bold">Started</th>
                  <th className="px-3 py-2 font-bold">Status</th>
                  <th className="px-3 py-2 font-bold">Sync</th>
                  <th className="px-3 py-2 font-bold">Side</th>
                  <th className="px-3 py-2 font-bold text-right">Qty</th>
                  <th className="px-3 py-2 font-bold text-right">Entry</th>
                  <th className="px-3 py-2 font-bold text-right">Stop</th>
                  <th className="px-3 py-2 font-bold text-right">Target</th>
                  <th className="px-3 py-2 font-bold text-right">R/R</th>
                  <th className="px-3 py-2 font-bold text-right">Max Loss</th>
                  <th className="px-3 py-2 font-bold text-right">Result</th>
                  <th className="px-3 py-2 font-bold text-right">Record</th>
                </tr>
              </thead>
              <tbody>
                {visibleWatches.map((item) => (
                  <tr key={item.id} className="border-b border-card-border/50 hover:bg-card">
                    <td className="px-3 py-2 text-muted">{item.startedAt}</td>
                    <td className="px-3 py-2">
                      <Badge tone={paperWatchStatusTone(item.status)}>{item.status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={paperWatchSyncTone(item.syncStatus)}>{paperWatchSyncLabel(item.syncStatus)}</Badge>
                    </td>
                    <td className={["px-3 py-2 font-bold", item.side === "BUY" ? "text-profit" : "text-loss"].join(" ")}>{item.side}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{item.quantity.toLocaleString("en-IN")}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{formatPrice(item.entry)}</td>
                    <td className="px-3 py-2 text-right font-mono text-loss">{formatPrice(item.stop)}</td>
                    <td className="px-3 py-2 text-right font-mono text-profit">{formatPrice(item.target)}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{formatNumber(item.riskReward, 2)}</td>
                    <td className="px-3 py-2 text-right font-mono font-bold text-loss">{formatCurrency(item.maxLoss)}</td>
                    <td className={["px-3 py-2 text-right font-mono font-bold", (item.realizedR ?? 0) > 0 ? "text-profit" : (item.realizedR ?? 0) < 0 ? "text-loss" : "text-muted"].join(" ")}>
                      {item.outcome ? `${item.outcome} ${formatSignedNumber(item.realizedR ?? 0, 2)}R` : "-"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {item.status === "Watching" && item.syncStatus === "synced" ? (
                        <div className="flex justify-end gap-1">
                          {(["WIN", "LOSS", "SKIP"] as const).map((outcome) => {
                            const pendingKey = `${item.id}:${outcome}`;
                            return (
                              <button
                                key={outcome}
                                type="button"
                                disabled={outcomePendingId !== null}
                                onClick={() => handleRecordOutcome(item, outcome)}
                                className={[
                                  "rounded border px-2 py-1 text-[11px] font-bold transition-colors",
                                  outcome === "WIN"
                                    ? "border-profit/25 text-profit hover:bg-profit-bg"
                                    : outcome === "LOSS"
                                      ? "border-loss/25 text-loss hover:bg-loss-bg"
                                      : "border-card-border text-muted hover:border-warning/30 hover:text-warning",
                                  outcomePendingId === pendingKey ? "bg-card-border/40" : "",
                                  outcomePendingId !== null ? "cursor-not-allowed opacity-60" : "",
                                ].join(" ")}
                              >
                                {outcomePendingId === pendingKey ? "..." : outcome}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-[11px] font-semibold text-muted">
                          {item.status === "Watching" ? "Sync first" : "Done"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function TicketField({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={["mt-1 truncate text-sm font-bold", toneClass(tone)].join(" ")} title={value}>
        {value}
      </div>
    </div>
  );
}

function PaperLedger({ strategy }: { strategy: StrategyPack }) {
  const runs = PAPER_RUNS.filter((run) => run.strategyId === strategy.id);
  const closed = runs.filter((run) => run.status === "Closed");
  const wins = closed.filter((run) => run.r > 0);
  const avgR = closed.length > 0 ? closed.reduce((sum, run) => sum + run.r, 0) / closed.length : 0;
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const open = runs.filter((run) => run.status === "Open").length;

  return (
    <section className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex flex-col gap-3 border-b border-card-border pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-warning">Illustrative example</div>
          <h3 className="mt-1 text-lg font-bold text-text-heading">{strategy.shortName} sample ledger</h3>
          <p className="mt-1 text-xs text-muted">Illustrative sample trades. These figures are examples and are not measured strategy performance.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <SizingMetric label="Win Rate" value={`${formatNumber(winRate, 0)}%`} tone={winRate >= 55 ? "good" : "warn"} />
            <SizingMetric label="Avg R" value={formatNumber(avgR, 2)} tone={avgR > 0 ? "good" : "bad"} />
            <SizingMetric label="Open" value={open.toString()} tone={open > 0 ? "warn" : "neutral"} />
          </div>
          <button
            type="button"
            onClick={() => exportPaperLedgerCsv(strategy, runs)}
            className="rounded-md border border-card-border px-3 py-2 text-xs font-bold text-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="text-[11px] uppercase tracking-wide text-muted">
            <tr className="border-b border-card-border">
              <th className="px-3 py-2 font-bold">Date</th>
              <th className="px-3 py-2 font-bold">Symbol</th>
              <th className="px-3 py-2 font-bold">Side</th>
              <th className="px-3 py-2 font-bold text-right">Entry</th>
              <th className="px-3 py-2 font-bold text-right">Exit</th>
              <th className="px-3 py-2 font-bold text-right">R</th>
              <th className="px-3 py-2 font-bold">Status</th>
              <th className="px-3 py-2 font-bold">Read</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={`${run.strategyId}-${run.symbol}-${run.date}`} className="border-b border-card-border/50 hover:bg-page-bg/50">
                <td className="px-3 py-2 text-muted">{run.date}</td>
                <td className="px-3 py-2 font-bold text-text-heading">{run.symbol}</td>
                <td className={["px-3 py-2 font-bold", run.side === "LONG" ? "text-profit" : "text-loss"].join(" ")}>{run.side}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{formatPrice(run.entry)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{run.exit ? formatPrice(run.exit) : "-"}</td>
                <td className={["px-3 py-2 text-right font-bold", run.r >= 1 ? "text-profit" : run.r < 0 ? "text-loss" : "text-warning"].join(" ")}>
                  {run.r > 0 ? "+" : ""}
                  {formatNumber(run.r, 2)}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={run.status === "Closed" ? "good" : run.status === "Open" ? "warn" : "neutral"}>{run.status}</Badge>
                </td>
                <td className="px-3 py-2 text-text-secondary">{run.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 w-full rounded-lg border border-card-border bg-card px-3 py-2 text-sm font-semibold text-text-heading outline-none transition-colors focus:border-accent"
      />
    </label>
  );
}

function SizingMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={["mt-1 text-sm font-bold", toneClass(tone)].join(" ")}>{value}</div>
    </div>
  );
}

function Checklist({
  title,
  items,
  icon: Icon,
  tone,
}: {
  title: string;
  items: string[];
  icon: LucideIcon;
  tone: "good" | "warn" | "bad";
}) {
  return (
    <div>
      <div className={["mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide", toneClass(tone)].join(" ")}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item} className="rounded-lg border border-card-border bg-card px-3 py-2 text-xs leading-relaxed text-text-secondary">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-page-bg/50 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</div>
      <div className="mt-1 text-sm leading-relaxed text-text-heading">{value}</div>
    </div>
  );
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "neutral" }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded px-2 py-1 text-[11px] font-bold ring-1",
        tone === "good"
          ? "bg-profit-bg text-profit ring-profit/20"
          : tone === "warn"
            ? "bg-warning/10 text-warning ring-warning/20"
            : tone === "bad"
              ? "bg-loss-bg text-loss ring-loss/20"
              : "bg-card text-muted ring-card-border",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function toneClass(tone: "good" | "warn" | "bad" | "neutral") {
  if (tone === "good") return "text-profit";
  if (tone === "warn") return "text-warning";
  if (tone === "bad") return "text-loss";
  return "text-text-heading";
}

function modeLabel(mode: AlgoMode) {
  if (mode === "paper") return "Paper mode";
  if (mode === "preview") return "Order preview";
  return "Live disabled";
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number, digits: number) {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.00";
}

function formatSignedNumber(value: number, digits: number) {
  if (!Number.isFinite(value)) return "0.00";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function isStrategyId(value: unknown): value is StrategyId {
  return typeof value === "string" && STRATEGIES.some((strategy) => strategy.id === value);
}

function normalizePaperWatch(raw: RawPaperWatch | undefined): PaperWatch | null {
  if (!raw || !raw.id || !isStrategyId(raw.strategyId)) return null;
  const quantity = Number(raw.quantity);
  const entry = Number(raw.entry);
  const stop = Number(raw.stop);
  const target = Number(raw.target);
  const maxLoss = Number(raw.maxLoss);
  const exposure = Number(raw.exposure);
  const riskReward = Number(raw.riskReward);
  if (![quantity, entry, stop, target, maxLoss, exposure, riskReward].every(Number.isFinite)) return null;

  return {
    id: String(raw.id),
    strategyId: raw.strategyId,
    strategyName: String(raw.strategyName || raw.strategyId),
    side: String(raw.side || "BUY"),
    quantity,
    entry,
    stop,
    target,
    exposure,
    maxLoss,
    riskReward,
    status: normalizePaperWatchStatus(raw.status),
    startedAt: formatPaperWatchTime(raw.createdAt || raw.startedAt),
    syncStatus: "synced",
    outcome: normalizePaperWatchOutcome(raw.outcome),
    exit: raw.exit == null ? null : Number(raw.exit),
    realizedR: raw.realizedR == null ? null : Number(raw.realizedR),
  };
}

function normalizePaperWatchStatus(status: unknown): PaperWatch["status"] {
  const value = String(status || "").toUpperCase();
  if (value === "CLOSED") return "Closed";
  if (value === "SKIPPED") return "Skipped";
  return "Watching";
}

function normalizePaperWatchOutcome(outcome: unknown): PaperWatch["outcome"] | undefined {
  if (outcome === "WIN" || outcome === "LOSS" || outcome === "SKIP") return outcome;
  return undefined;
}

function formatPaperWatchTime(value: unknown) {
  if (typeof value !== "string" || !value) return new Date().toLocaleString("en-IN", paperWatchTimeFormat);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-IN", paperWatchTimeFormat);
}

const paperWatchTimeFormat: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
};

function mergePaperWatches(priority: PaperWatch[], current: PaperWatch[]) {
  const merged = new Map<string, PaperWatch>();
  [...current, ...priority].forEach((watch) => {
    merged.set(watch.id, { ...merged.get(watch.id), ...watch });
  });
  return Array.from(merged.values());
}

function paperWatchStatusTone(status: PaperWatch["status"]): "good" | "warn" | "bad" | "neutral" {
  if (status === "Closed") return "good";
  if (status === "Skipped") return "neutral";
  return "warn";
}

function paperWatchSyncLabel(syncStatus: PaperWatch["syncStatus"]) {
  if (syncStatus === "synced") return "Synced";
  if (syncStatus === "syncing") return "Syncing";
  if (syncStatus === "failed") return "Local only";
  return "Local";
}

function paperWatchSyncTone(syncStatus: PaperWatch["syncStatus"]): "good" | "warn" | "bad" | "neutral" {
  if (syncStatus === "synced") return "good";
  if (syncStatus === "syncing") return "warn";
  if (syncStatus === "failed") return "bad";
  return "neutral";
}

function shortApiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  return message.replace(/\s+/g, " ").slice(0, 160);
}

function promotionCheckRows(performance: StrategyPerformance) {
  const criteria = performance.promotionCriteria ?? {};
  return [
    {
      label: "Sample",
      pass: performance.promotionChecks.paperFires,
      value: `${performance.resolved}/${criteria.minPaperFires ?? 0} fires`,
    },
    {
      label: "Win Rate",
      pass: performance.promotionChecks.winRate,
      value: `${formatNumber(performance.winRatePct, 1)}% / ${criteria.minWinRatePct ?? 0}%`,
    },
    {
      label: "Avg R",
      pass: performance.promotionChecks.avgR,
      value: `${formatSignedNumber(performance.avgR, 2)}R / ${formatNumber(criteria.minAvgR ?? 0, 2)}R`,
    },
    {
      label: "Drawdown",
      pass: performance.promotionChecks.drawdown,
      value: `${formatNumber(performance.maxDrawdownR, 2)}R cap ${formatNumber(criteria.maxSampleDrawdownR ?? 0, 2)}R`,
    },
  ];
}

function exportStagedTicketsCsv(strategy: StrategyPack, tickets: StagedTicket[]) {
  const rows = tickets.map((item) => ({
    strategy: item.strategyName,
    time: item.stagedAt,
    mode: modeLabel(item.mode),
    route: item.route,
    side: item.side,
    product: item.product,
    quantity: item.quantity,
    limit: item.limitPrice,
    stop: item.stop,
    target: item.target,
    risk_reward: item.riskReward ?? "",
    exposure: item.exposure ?? "",
    max_loss: item.maxLoss,
  }));
  downloadCsv(`alpha-radar-${strategy.id}-staged-tickets.csv`, rows);
}

function exportPaperWatchesCsv(strategy: StrategyPack, watches: PaperWatch[]) {
  const rows = watches.map((item) => ({
    strategy: item.strategyName,
    started_at: item.startedAt,
    status: item.status,
    sync: paperWatchSyncLabel(item.syncStatus),
    outcome: item.outcome ?? "",
    realized_r: item.realizedR ?? "",
    exit: item.exit ?? "",
    side: item.side,
    quantity: item.quantity,
    entry: item.entry,
    stop: item.stop,
    target: item.target,
    risk_reward: item.riskReward,
    exposure: item.exposure,
    max_loss: item.maxLoss,
  }));
  downloadCsv(`alpha-radar-${strategy.id}-paper-watches.csv`, rows);
}

function exportPaperLedgerCsv(strategy: StrategyPack, runs: PaperRun[]) {
  const rows = runs.map((run) => ({
    strategy: strategy.shortName,
    date: run.date,
    symbol: run.symbol,
    side: run.side,
    entry: run.entry,
    exit: run.exit ?? "",
    r: run.r,
    status: run.status,
    read: run.note,
  }));
  downloadCsv(`alpha-radar-${strategy.id}-paper-ledger.csv`, rows);
}

function downloadCsv(filename: string, rows: Record<string, string | number>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([toStampedJson(payload)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toStampedJson(payload: unknown) {
  return JSON.stringify(toStampedPayload(payload), null, 2);
}

function toStampedPayload(payload: unknown) {
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), generatedAt: new Date().toISOString() }
      : { generatedAt: new Date().toISOString(), payload };
  return body;
}

function csvCell(value: string | number) {
  const raw = String(value ?? "");
  return `"${raw.replace(/"/g, '""')}"`;
}

function nextAction(strategy: StrategyPack, mode: AlgoMode) {
  if (mode === "paper") {
    return `Track ${strategy.shortName} signals, store every trigger, and score post-trade follow-through before allowing order preview.`;
  }
  if (mode === "preview") {
    return `Generate a manual order ticket only after all ${strategy.shortName} gates pass, with stop, target, quantity, and slippage cap prefilled.`;
  }
  return "Live routing remains locked until paper performance, broker approval, user consent, and hard risk limits are in place.";
}
