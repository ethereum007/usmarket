"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Clock3, Gauge, Search, ShieldCheck, Target, TrendingUp, Zap, type LucideIcon } from "lucide-react";
import { fetchAPI, postAPI } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";
import { type UniverseKey, UNIVERSE_META, getUniverse } from "../../lib/stock-universe";

interface SwingSignal {
  research_phase?: SwingPhaseKey;
  symbol: string;
  strategy:
    | "EARLY_MOMENTUM"
    | "LIQUIDITY_SHOCK"
    | "VOL_SQUEEZE"
    | "RS_PULLBACK"
    | "ACCELERATION"
    | "MOMENTUM_BURST"
    | "10D_BO"
    | "50D_BO"
    | "REVERSAL"
    | "CHANNEL_BO";
  signal: "BULL" | "BEAR";
  current_price: number;
  change_pct: number;
  trigger_date: string;
  breakout_level: number;
  stop_loss: number;
  target: number;
  strength: number;
  notes: string;
  entry_price?: number;
  risk_pct?: number;
  reward_pct?: number;
  rr?: number;
  hold_days?: string;
  trend_score?: number;
  volume_score?: number;
  pattern_score?: number;
  quality?: "A+" | "A" | "B" | "WATCH";
  rvol?: number;
  setup_phase?: "LIVE_MOMENTUM" | "CONFIRMED_CLOSE" | string;
  reasons?: string[];
  benchmark_rs_20?: number | null;
  benchmark_rs_60?: number | null;
  weekly_trend?: "BULLISH" | "BEARISH" | "MIXED" | string;
  distance_to_trigger_pct?: number;
  extension_atr?: number;
  lifecycle_state?: "FORMING" | "READY" | "TRIGGERED" | "PULLBACK_ENTRY" | "EXTENDED_AVOID" | string;
}

interface SwingStrategyEdge {
  label: string;
  action: string;
  score: number | null;
  sample: string;
  reason: string;
}

interface SwingStrategyPreferred {
  total: number;
  resolved: number;
  pending: number;
  wins: number;
  losses: number;
  flats: number;
  win_rate: number | null;
  avg_return_pct: number | null;
  avg_mfe_pct: number | null;
  avg_mae_pct: number | null;
  edge: SwingStrategyEdge;
}

interface SwingStrategyHealthRow {
  key: string;
  label: string;
  fires: number;
  symbol_count: number;
  preferred_horizon: string;
  preferred: SwingStrategyPreferred;
  roles: Record<string, number>;
  readiness: Record<string, number>;
  quality_mix: Record<string, number>;
}

interface PerformanceStatsResponse {
  success: boolean;
  swing_strategy_health?: {
    strategies: SwingStrategyHealthRow[];
    summary?: {
      strategies: number;
      trusted: number;
      paused: number;
      needs_sample: number;
      best?: string | null;
    };
  };
}

interface SwingRadarVote {
  strategy: SwingSignal["strategy"];
  signal: SwingSignal["signal"];
  phase: SwingPhaseKey;
  score: number;
  strength?: number;
  quality?: SwingSignal["quality"];
  rr?: number;
  risk_pct?: number;
}

interface SwingRadarRow {
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  phase: SwingPhaseKey;
  action: "PLAN_ENTRY" | "BUILD_WATCH" | "CONFIRM_TAPE" | "WAIT_TRIGGER" | "AVOID_CHASE" | "WAIT_CONFLICT" | "WATCH" | string;
  score: number;
  confidence: number;
  strategy_count: number;
  strategies: SwingSignal["strategy"][];
  votes: SwingRadarVote[];
  primary_signal: SwingSignal;
  entry?: number;
  stop?: number;
  target?: number;
  risk_reward?: number;
  risk_pct?: number;
  reward_pct?: number;
  change_pct?: number;
  current_price?: number;
  hold_days?: string;
  evidence?: string[];
  risks?: string[];
}

interface SwingResponse {
  scope?: { version: number; universe: string; mode: string; attempted_symbols: string[]; attempted_count: number };
  success?: boolean;
  count: number;
  summary: { total: number; bullish: number; bearish: number; a_plus?: number; a?: number };
  strategies: Record<SwingSignal["strategy"], SwingSignal[]>;
  results?: SwingSignal[];
  radar?: { rows: SwingRadarRow[]; best?: SwingRadarRow | null; summary?: Record<string, number> };
  composite?: SwingRadarRow[];
  best_swing?: SwingRadarRow | null;
  best_trade?: SwingSignal | null;
  no_trade_reason?: string | null;
  timestamp?: number;
  cached?: boolean;
  cachedAt?: string;
  snapshotWarning?: string;
}

type SwingMode = "live" | "snapshot";
type SwingPhaseKey = "UNKNOWN" | "EARLY_ACCUMULATION" | "READY_BREAKOUT" | "LIVE_MOMENTUM" | "PULLBACK_WATCH" | "EXTENDED_AVOID";

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

interface HistoryResponse {
  success: boolean;
  data: Array<Record<string, unknown>>;
}

const PANELS: Array<{ key: SwingSignal["strategy"]; label: string; desc: string }> = [
  { key: "EARLY_MOMENTUM", label: "Early Momentum", desc: "base reclaim and accumulation before the move is obvious" },
  { key: "LIQUIDITY_SHOCK", label: "Liquidity Shock", desc: "high-volume absorption or distribution before the clean breakout" },
  { key: "VOL_SQUEEZE", label: "Vol Squeeze", desc: "tight range, low volatility, and volume waking near trigger" },
  { key: "RS_PULLBACK", label: "RS Pullback", desc: "strong leaders cooling into support with trend intact" },
  { key: "ACCELERATION", label: "Acceleration Watch", desc: "multi-day swing expansion, including wait-for-pullback names" },
  { key: "MOMENTUM_BURST", label: "Momentum Burst", desc: "live high-RVOL moves already in motion" },
  { key: "10D_BO", label: "10D Breakout", desc: "fast momentum above/below recent range" },
  { key: "50D_BO", label: "50D Breakout", desc: "positional breakout with trend confirmation" },
  { key: "REVERSAL", label: "Pullback Reversal", desc: "trend pullback reclaim or rejection" },
  { key: "CHANNEL_BO", label: "Channel Breakout", desc: "tight Donchian expansion" },
];

const STRATEGY_LABELS: Record<SwingSignal["strategy"], string> = {
  EARLY_MOMENTUM: "EARLY",
  LIQUIDITY_SHOCK: "LIQUIDITY",
  VOL_SQUEEZE: "SQUEEZE",
  RS_PULLBACK: "RS PULLBACK",
  ACCELERATION: "ACCEL",
  MOMENTUM_BURST: "MOMENTUM",
  "10D_BO": "10D BO",
  "50D_BO": "50D BO",
  REVERSAL: "REVERSAL",
  CHANNEL_BO: "CHANNEL",
};

const SWING_MOMENTUM_WATCH = [
  "NETWEB",
  "DATAPATTNS",
  "CARTRADE",
  "KAYNES",
  "PGEL",
  "ZENTEC",
  "IDEAFORGE",
  "TITAGARH",
  "BEML",
  "COCHINSHIP",
  "MAZDOCK",
  "OLECTRA",
  "TEJASNET",
];

const RADAR_CANDIDATE_STORAGE_KEY = "alpha-radar:selected-candidate";

const SWING_PHASE_ORDER: SwingPhaseKey[] = [
  "EARLY_ACCUMULATION",
  "READY_BREAKOUT",
  "LIVE_MOMENTUM",
  "PULLBACK_WATCH",
  "EXTENDED_AVOID",
  "UNKNOWN",
];

const SWING_PHASE_META: Record<SwingPhaseKey, { label: string; short: string; desc: string; action: string; tone: "profit" | "accent" | "warning" | "loss" | "muted" }> = {
  UNKNOWN: { label: "Unknown lifecycle", short: "Unknown", desc: "Lifecycle evidence is missing. Review source data before planning.", action: "Verify data", tone: "muted" },
  EARLY_ACCUMULATION: {
    label: "Early Positioning",
    short: "Early",
    desc: "Low-to-moderate price move with absorption, distribution, squeeze, or reclaim evidence before the move is obvious.",
    action: "Build watch",
    tone: "accent",
  },
  READY_BREAKOUT: {
    label: "Ready Breakout",
    short: "Ready",
    desc: "Trigger is close, risk is defined, and reward is still acceptable.",
    action: "Plan entry",
    tone: "profit",
  },
  LIVE_MOMENTUM: {
    label: "Live Momentum",
    short: "Live",
    desc: "Move is already active. Use confirmation or pullback, avoid chasing stretched prints.",
    action: "Confirm tape",
    tone: "warning",
  },
  PULLBACK_WATCH: {
    label: "Pullback Watch",
    short: "Pullback",
    desc: "Trend exists, but a cleaner entry needs reclaim, support hold, or close confirmation.",
    action: "Wait trigger",
    tone: "muted",
  },
  EXTENDED_AVOID: {
    label: "Extended / Avoid",
    short: "Avoid",
    desc: "The signal is late, wide-risk, or poor reward/risk. Good for tracking, not chasing.",
    action: "Avoid chase",
    tone: "loss",
  },
};

function formatPct(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatMemoryPct(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function formatMemorySigned(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function memoryHorizonLabel(value: string) {
  if (value === "next_day_eod") return "Next-day EOD";
  if (value === "eod") return "EOD";
  if (value === "1h") return "1H";
  if (value === "15m") return "15M";
  return value.replaceAll("_", " ").toUpperCase();
}

function memoryRateTone(value?: number | null) {
  if (typeof value !== "number") return "text-muted";
  if (value >= 60) return "text-profit";
  if (value >= 45) return "text-warning";
  return "text-loss";
}

function memoryReturnTone(value?: number | null) {
  if (typeof value !== "number") return "text-muted";
  if (value > 0) return "text-profit";
  if (value < 0) return "text-loss";
  return "text-muted";
}

function memoryEdgeLabel(label: string) {
  if (label === "SIZE_UP") return "SIZE";
  if (label === "TRADE_SMALL") return "SMALL";
  if (label === "NEEDS_SAMPLE") return "SAMPLE";
  return label.replaceAll("_", " ");
}

function memoryEdgeClass(label: string) {
  if (label === "SIZE_UP") return "bg-profit-bg text-profit";
  if (label === "TRADE_SMALL") return "bg-accent-bg text-accent";
  if (label === "PAUSE") return "bg-loss-bg text-loss";
  return "bg-warning/10 text-warning";
}

function scoreTone(signal: SwingSignal) {
  return signal.signal === "BULL" ? "text-profit" : "text-loss";
}

function qualityClass(quality?: string) {
  if (quality === "A+") return "bg-profit text-white";
  if (quality === "A") return "bg-profit-bg text-profit";
  if (quality === "B") return "bg-warning/10 text-warning";
  return "bg-card-border/40 text-muted";
}

function signalKey(signal: SwingSignal) {
  return `${signal.symbol}-${signal.strategy}-${signal.signal}`;
}

function getSwingPhase(signal: SwingSignal): SwingPhaseKey {
  if (signal.research_phase && SWING_PHASE_ORDER.includes(signal.research_phase)) return signal.research_phase;
  if ((!signal.lifecycle_state || signal.lifecycle_state === "UNKNOWN") && (!signal.setup_phase || signal.setup_phase === "UNKNOWN")) return "UNKNOWN";
  const change = Math.abs(signal.change_pct || 0);
  const risk = signal.risk_pct || 0;
  const rr = signal.rr || 0;
  const rvol = signal.rvol || 0;

  if (signal.lifecycle_state === "EXTENDED_AVOID") return "EXTENDED_AVOID";
  if (signal.lifecycle_state === "TRIGGERED") return "LIVE_MOMENTUM";
  if (signal.lifecycle_state === "READY") return "READY_BREAKOUT";
  if (signal.lifecycle_state === "PULLBACK_ENTRY") return "PULLBACK_WATCH";
  if (signal.lifecycle_state === "FORMING") return "EARLY_ACCUMULATION";

  if (signal.setup_phase === "EXTENDED_WAIT" || change >= 9 || risk >= 7 || rr < 1.1) {
    return "EXTENDED_AVOID";
  }

  if (signal.setup_phase === "LIVE_MOMENTUM" || signal.strategy === "MOMENTUM_BURST") {
    return change <= 6 && rr >= 1.4 ? "LIVE_MOMENTUM" : "EXTENDED_AVOID";
  }

  if (
    signal.setup_phase === "EARLY_IGNITION" ||
    signal.setup_phase === "FIRST_RECLAIM" ||
    signal.setup_phase === "LIQUIDITY_ABSORPTION" ||
    signal.setup_phase === "SQUEEZE_READY" ||
    signal.strategy === "EARLY_MOMENTUM" ||
    signal.strategy === "LIQUIDITY_SHOCK" ||
    signal.strategy === "VOL_SQUEEZE" ||
    (change <= 3.5 && rvol >= 1.2 && (signal.trend_score || 0) >= 55)
  ) {
    return "EARLY_ACCUMULATION";
  }

  if (
    signal.strategy === "REVERSAL" ||
    signal.strategy === "RS_PULLBACK" ||
    signal.strategy === "ACCELERATION" ||
    signal.setup_phase === "RS_PULLBACK" ||
    (change <= 2.5 && (signal.pattern_score || 0) >= 55)
  ) {
    return "PULLBACK_WATCH";
  }

  if ((signal.quality === "A+" || signal.quality === "A" || (signal.strength || 0) >= 72) && rr >= 1.4 && risk <= 6) {
    return "READY_BREAKOUT";
  }

  return rr >= 1.4 ? "PULLBACK_WATCH" : "EXTENDED_AVOID";
}

function phaseToneClass(phase: SwingPhaseKey, variant: "soft" | "text" | "solid" = "soft") {
  const tone = SWING_PHASE_META[phase].tone;
  if (variant === "solid") {
    if (tone === "profit") return "bg-profit text-white";
    if (tone === "accent") return "bg-accent text-white";
    if (tone === "warning") return "bg-warning text-white";
    if (tone === "loss") return "bg-loss text-white";
    return "bg-card-border text-text-heading";
  }
  if (variant === "text") {
    if (tone === "profit") return "text-profit";
    if (tone === "accent") return "text-accent";
    if (tone === "warning") return "text-warning";
    if (tone === "loss") return "text-loss";
    return "text-muted";
  }
  if (tone === "profit") return "bg-profit-bg text-profit ring-profit/15";
  if (tone === "accent") return "bg-accent-bg text-accent ring-accent/15";
  if (tone === "warning") return "bg-warning/10 text-warning ring-warning/20";
  if (tone === "loss") return "bg-loss-bg text-loss ring-loss/15";
  return "bg-page-bg text-muted ring-card-border";
}

function decisionLabel(signal: SwingSignal) {
  const phase = getSwingPhase(signal);
  if (phase === "EXTENDED_AVOID") return "Avoid chase";
  if (phase === "EARLY_ACCUMULATION") return "Early watch";
  if ((signal.quality === "A+" || signal.quality === "A") && (signal.rr || 0) >= 1.6 && (signal.risk_pct || 0) <= 5.5) {
    return "Actionable";
  }
  if (phase === "LIVE_MOMENTUM") return "Confirm live";
  return "Wait trigger";
}

function confidenceWidth(value?: number) {
  return `${Math.max(6, Math.min(100, Math.round(value || 0)))}%`;
}

function formatHold(signal?: SwingSignal | null) {
  return signal?.hold_days || "2-10D";
}

function thesisText(signal: SwingSignal) {
  const bias = signal.signal === "BULL" ? "bullish" : "bearish";
  const trigger = formatNumber(signal.breakout_level || signal.entry_price || signal.current_price);
  const invalidation = formatNumber(signal.stop_loss);
  const phase = getSwingPhase(signal);

  if (phase === "EARLY_ACCUMULATION") {
    return `Early ${bias} setup. Watch for follow-through above ${trigger}; thesis weakens if price fails and closes beyond ${invalidation}.`;
  }
  if (phase === "READY_BREAKOUT") {
    return `Ready ${bias} breakout candidate with defined risk. Entry discipline matters around ${trigger}; invalidate beyond ${invalidation}.`;
  }
  if (phase === "LIVE_MOMENTUM") {
    return `Live ${bias} momentum. Prefer confirmation, retest, or intraday strength; do not chase if spread or risk widens.`;
  }
  if (phase === "PULLBACK_WATCH") {
    return `Trend exists, but the cleaner swing entry needs a reclaim or support hold. Keep it on watch instead of forcing it.`;
  }
  return `Late or wide-risk setup. Track it for learning, but wait for a reset before treating it as a fresh swing entry.`;
}

function bestPerSymbol(signals: SwingSignal[]) {
  const bySymbol = new Map<string, SwingSignal>();
  for (const signal of signals) {
    const existing = bySymbol.get(signal.symbol);
    const signalScore = (signal.strength || 0) + (signal.rr || 0) * 2 - (signal.risk_pct || 0);
    const existingScore = existing ? (existing.strength || 0) + (existing.rr || 0) * 2 - (existing.risk_pct || 0) : -Infinity;
    if (!existing || signalScore > existingScore) bySymbol.set(signal.symbol, signal);
  }
  return Array.from(bySymbol.values()).sort((a, b) => {
    const scoreA = (a.strength || 0) + (a.rr || 0) * 2 - (a.risk_pct || 0);
    const scoreB = (b.strength || 0) + (b.rr || 0) * 2 - (b.risk_pct || 0);
    return scoreB - scoreA;
  });
}

function radarRowKey(row: SwingRadarRow) {
  return `${row.symbol}-${row.phase}-${row.direction}`;
}

function primarySignalKey(row: SwingRadarRow) {
  return row.primary_signal ? signalKey(row.primary_signal) : radarRowKey(row);
}

export default function SwingContent() {
  const [universe, setUniverse] = useState<UniverseKey>("nifty50");
  const [data, setData] = useState<SwingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<SwingMode>("live");
  const [replayLoading, setReplayLoading] = useState(false);
  const [warmLoading, setWarmLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayMeta, setReplayMeta] = useState<SnapshotDetailResponse<SwingResponse>["snapshot"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [filterSignal, setFilterSignal] = useState<"all" | "BULL" | "BEAR">("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [strategyHealth, setStrategyHealth] = useState<SwingStrategyHealthRow[]>([]);
  const [strategyHealthLoading, setStrategyHealthLoading] = useState(true);
  const [strategyHealthError, setStrategyHealthError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadStrategyHealth() {
      setStrategyHealthLoading(true);
      setStrategyHealthError(null);
      try {
        const result = await fetchAPI<PerformanceStatsResponse>("/api/performance/signal-stats?days=30");
        if (!active) return;
        setStrategyHealth(result.swing_strategy_health?.strategies || []);
      } catch (err) {
        if (!active) return;
        setStrategyHealth([]);
        setStrategyHealthError(err instanceof Error ? err.message : "Strategy memory unavailable");
      } finally {
        if (active) setStrategyHealthLoading(false);
      }
    }

    loadStrategyHealth();
    return () => {
      active = false;
    };
  }, []);

  const rankedSignals = useMemo(() => {
    const source = data?.results?.length
      ? data.results
      : data
        ? Object.values(data.strategies).flat()
        : [];
    const filtered = filterSignal === "all" ? source : source.filter((s) => s.signal === filterSignal);
    return bestPerSymbol(filtered);
  }, [data, filterSignal]);

  const radarRows = useMemo(() => {
    const source = data?.radar?.rows?.length ? data.radar.rows : data?.composite || [];
    return source.filter((row) => {
      if (filterSignal === "all") return true;
      return filterSignal === "BULL" ? row.direction === "LONG" : row.direction === "SHORT";
    });
  }, [data, filterSignal]);

  const visibleSignals = useMemo(() => {
    const query = searchTerm.trim().toUpperCase();
    if (!query) return rankedSignals;
    return rankedSignals.filter((signal) => {
      const haystack = [
        signal.symbol,
        signal.strategy,
        signal.signal,
        signal.quality || "",
        signal.setup_phase || "",
        signal.notes,
        ...(signal.reasons || []),
      ].join(" ").toUpperCase();
      return haystack.includes(query);
    });
  }, [rankedSignals, searchTerm]);

  const phaseBuckets = useMemo(() => {
    const buckets: Record<SwingPhaseKey, SwingSignal[]> = {
      UNKNOWN: [],
      EARLY_ACCUMULATION: [],
      READY_BREAKOUT: [],
      LIVE_MOMENTUM: [],
      PULLBACK_WATCH: [],
      EXTENDED_AVOID: [],
    };
    for (const signal of rankedSignals) {
      buckets[getSwingPhase(signal)].push(signal);
    }
    return buckets;
  }, [rankedSignals]);

  const radarPhaseBuckets = useMemo(() => {
    const buckets: Record<SwingPhaseKey, SwingRadarRow[]> = {
      UNKNOWN: [],
      EARLY_ACCUMULATION: [],
      READY_BREAKOUT: [],
      LIVE_MOMENTUM: [],
      PULLBACK_WATCH: [],
      EXTENDED_AVOID: [],
    };
    for (const row of radarRows) {
      buckets[row.phase]?.push(row);
    }
    return buckets;
  }, [radarRows]);

  const strategyHealthByKey = useMemo(() => {
    const map = new Map<string, SwingStrategyHealthRow>();
    for (const row of strategyHealth) map.set(row.key, row);
    return map;
  }, [strategyHealth]);

  async function runScan() {
    setLoading(true);
    setError(null);
    setReplayError(null);
    setReplayMeta(null);
    setMode("live");
    setProgress(0);

    const baseSymbols = getUniverse(universe);
    const symbols = Array.from(new Set(
      ["nifty200", "nifty500", "smallcap", "microcap"].includes(universe)
        ? [...baseSymbols, ...SWING_MOMENTUM_WATCH]
        : baseSymbols,
    ));

    try {
      const batchPayload: Array<{ symbol: string; daily: Array<Record<string, unknown>> }> = [];
      const batchSize = 6;
      let benchmark: Array<Record<string, unknown>> = [];

      try {
        const benchmarkRes = await fetchAPI<HistoryResponse>(
          "/api/quotes/history?symbol=NIFTY%20500&interval=day&days=420",
        );
        if (benchmarkRes.success) benchmark = benchmarkRes.data;
      } catch {
        // Relative strength remains neutral when benchmark history is temporarily unavailable.
      }

      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        setProgress(Math.round((i / symbols.length) * 82));
        const promises = batch.map(async (sym) => {
          try {
            const res = await fetchAPI<HistoryResponse>(
              `/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=day&days=420`,
            );
            if (res.success && res.data.length >= 35) {
              batchPayload.push({
                symbol: sym,
                daily: res.data,
              });
            }
          } catch {
            // Skip symbols with missing history; the scan can still complete.
          }
        });
        await Promise.all(promises);
        if (i + batchSize < symbols.length) await new Promise((r) => setTimeout(r, 180));
      }

      setProgress(90);
      const result = await postAPI<SwingResponse>("/api/scanner/swing", {
        symbols: batchPayload,
        benchmark,
        universe,
        scope_mode: ["nifty50", "nifty100"].includes(universe) ? "strict" : "blended",
      });
      setData({ ...result, cached: false });
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swing scan failed");
    } finally {
      setLoading(false);
    }
  }

  async function warmReplay() {
    setWarmLoading(true);
    setError(null);
    setReplayError(null);
    setReplayMeta(null);
    setMode("live");
    setProgress(30);

    try {
      const limit = universe === "nifty50" ? 50 : universe === "nifty100" ? 100 : 160;
      const result = await postAPI<SwingResponse>("/api/scanner/swing/warm", { universe, limit, scope_mode: ["nifty50", "nifty100"].includes(universe) ? "strict" : "blended" });
      setData({ ...result, cached: false });
      setProgress(100);
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : "Could not warm Swing replay");
    } finally {
      setWarmLoading(false);
    }
  }

  async function loadReplay() {
    setReplayLoading(true);
    setReplayError(null);
    setError(null);
    setProgress(35);

    try {
      const res = await fetchAPI<SnapshotDetailResponse<SwingResponse>>("/api/snapshots/swing_spectrum");
      if (!res.data?.strategies || !res.data.summary) {
        throw new Error("Saved Swing Spectrum payload is not available yet.");
      }
      setData({
        ...res.data,
        cached: true,
        cachedAt: res.snapshot.timestamp ?? undefined,
        snapshotWarning: `Snapshot replay from ${res.snapshot.ageLabel || "last good scan"}`,
      });
      setReplayMeta(res.snapshot);
      setMode("snapshot");
      setProgress(100);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "Could not load saved Swing Spectrum snapshot";
      const msg = rawMessage.includes("No saved snapshot") || rawMessage.includes("404")
        ? "No saved Swing Spectrum replay is available yet. Run one successful swing scan to seed this replay."
        : rawMessage;
      setReplayError(msg);
    } finally {
      setReplayLoading(false);
      setLoading(false);
    }
  }

  function switchUniverse(key: UniverseKey) {
    setUniverse(key);
    if (mode === "snapshot") {
      setMode("live");
      setReplayMeta(null);
      setReplayError(null);
      setData(null);
    }
  }

  function returnToLive() {
    setMode("live");
    setReplayMeta(null);
    setReplayError(null);
    if (data?.cached) setData(null);
  }

  function filterSignals(signals: SwingSignal[]): SwingSignal[] {
    if (filterSignal === "all") return signals;
    return signals.filter((s) => s.signal === filterSignal);
  }

  function openSwingDecision(signal: SwingSignal) {
    window.sessionStorage.setItem(RADAR_CANDIDATE_STORAGE_KEY, JSON.stringify(toRadarCandidate(signal)));
    window.open(`/radar-trade?symbol=${encodeURIComponent(signal.symbol)}`, "_self");
  }

  function openCompositeDecision(row: SwingRadarRow) {
    window.sessionStorage.setItem(RADAR_CANDIDATE_STORAGE_KEY, JSON.stringify(toRadarCandidateFromComposite(row)));
    window.open(`/radar-trade?symbol=${encodeURIComponent(row.symbol)}`, "_self");
  }

  const bestComposite = filterSignal === "all" ? data?.radar?.best || data?.best_swing || radarRows[0] : radarRows[0];
  const bestTrade = filterSignal === "all" ? data?.best_trade || bestComposite?.primary_signal || rankedSignals[0] : bestComposite?.primary_signal || rankedSignals[0];
  const selectedSignal = useMemo(() => {
    if (!rankedSignals.length) return null;
    const selected = selectedKey ? rankedSignals.find((signal) => signalKey(signal) === selectedKey) : null;
    return selected || bestTrade || rankedSignals[0] || null;
  }, [bestTrade, rankedSignals, selectedKey]);
  const isBusy = loading || replayLoading || warmLoading;
  const selectedPhase = selectedSignal ? getSwingPhase(selectedSignal) : null;

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-xl border border-card-border bg-card">
        <div className="flex flex-col gap-4 border-b border-card-border px-4 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent-bg text-accent">
                <TrendingUp className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-text-heading">Find a swing setup</h2>
                <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted">
                  Find bottom-side momentum before it becomes obvious, separate ready breakouts from stretched moves, and open a decision cockpit only after the thesis is clear.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              options={(["all", "BULL", "BEAR"] as const).map((key) => ({ key, label: key === "all" ? "All" : key }))}
              value={filterSignal}
              onChange={setFilterSignal}
              disabled={isBusy}
              tone={(key) => (key === "BULL" ? "profit" : key === "BEAR" ? "loss" : "accent")}
            />
            <SegmentedControl
              options={(["nifty50", "nifty100", "nifty200", "nifty500", "smallcap", "microcap"] as UniverseKey[]).map((key) => ({
                key,
                label: UNIVERSE_META[key].shortLabel,
              }))}
              value={universe}
              onChange={switchUniverse}
              disabled={isBusy}
            />
            <SegmentedControl
              options={[
                { key: "live", label: "Live" },
                { key: "snapshot", label: "Replay" },
              ]}
              value={mode}
              onChange={(next) => (next === "live" ? returnToLive() : loadReplay())}
              disabled={isBusy}
              tone={(key) => (key === "snapshot" ? "warning" : "accent")}
            />
            <button
              type="button"
              onClick={warmReplay}
              disabled={isBusy}
              className="h-9 rounded-lg border border-warning/25 bg-warning/10 px-3 text-xs font-bold text-warning transition-colors hover:bg-warning/15 disabled:opacity-50"
            >
              {warmLoading ? "Warming" : "Warm Replay"}
            </button>
            <button
              type="button"
              onClick={runScan}
              disabled={isBusy}
              className="h-9 rounded-lg bg-accent px-4 text-xs font-bold text-white transition-colors hover:bg-accent/85 disabled:opacity-50"
            >
              {loading ? `Scanning ${progress}%` : "Scan Swing"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-y divide-card-border text-xs md:grid-cols-4 xl:grid-cols-6 xl:divide-y-0">
          <DeskStat icon={Clock3} label="Mode" value={mode === "snapshot" ? "Replay" : "Live scan"} sub={replayMeta?.ageLabel || "Daily candles"} tone={mode === "snapshot" ? "warning" : "accent"} />
          <DeskStat icon={Target} label="Universe" value={data ? (data.scope ? `${data.scope.universe} · ${data.scope.mode}` : "Scope unknown") : UNIVERSE_META[universe].label} sub={data?.scope ? `${data.scope.attempted_count} symbols attempted` : data ? "Legacy scan: membership unverified" : "Requested universe"} />
          <DeskStat icon={Gauge} label="Symbols" value={data ? (radarRows.length || rankedSignals.length) : 0} sub={data?.cached ? "Replay candidates" : "Setup candidates"} />
          <DeskStat icon={Zap} label="Early" value={(radarRows.length ? radarPhaseBuckets.EARLY_ACCUMULATION.length : phaseBuckets.EARLY_ACCUMULATION.length)} sub="accumulation watch" tone="accent" />
          <DeskStat icon={ShieldCheck} label="Ready" value={(radarRows.length ? radarPhaseBuckets.READY_BREAKOUT.length : phaseBuckets.READY_BREAKOUT.length)} sub="defined risk" tone="profit" />
          <DeskStat icon={TrendingUp} label="Extended" value={(radarRows.length ? radarPhaseBuckets.EXTENDED_AVOID.length : phaseBuckets.EXTENDED_AVOID.length)} sub="avoid chasing" tone="loss" />
        </div>
      </section>

      <StrategyMemoryStrip rows={strategyHealth} loading={strategyHealthLoading} error={strategyHealthError} />

      {error && <div className="rounded-lg border border-loss/20 bg-loss-bg p-4 text-sm text-loss">{error}</div>}
      {replayError && <div className="rounded-lg border border-warning/25 bg-warning/10 p-4 text-sm text-warning">{replayError}</div>}
      {mode === "snapshot" && replayMeta && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/10 p-4 text-sm text-warning">
          <span>
            Swing replay is active from {replayMeta.timestamp || "the last saved scan"} ({replayMeta.ageLabel || replayMeta.status} old).
          </span>
          <a href="/snapshots?key=swing_spectrum" className="font-semibold text-accent hover:underline">
            Open raw replay
          </a>
        </div>
      )}

      {isBusy && (
        <div className="rounded-xl border border-card-border bg-card p-6 text-center">
          <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-card-border/30">
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          <div className="animate-pulse text-sm font-semibold text-accent">
            {warmLoading
              ? "Warming server-side Swing replay..."
              : replayLoading
                ? "Loading last-good Swing snapshot..."
                : "Scanning daily candles for early accumulation, reclaim, and breakout setups..."}
          </div>
        </div>
      )}

      {!data && !isBusy && <EmptySwingState onReplay={loadReplay} onScan={runScan} />}

      {data && (
        <div className="grid grid-cols-1 gap-4 min-[1500px]:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
              {SWING_PHASE_ORDER.map((phase) => (
                <PhaseCard
                  key={phase}
                  phase={phase}
                  count={radarRows.length ? radarPhaseBuckets[phase].length : phaseBuckets[phase].length}
                  active={selectedPhase === phase}
                  top={radarRows.length ? radarPhaseBuckets[phase][0]?.primary_signal : phaseBuckets[phase][0]}
                />
              ))}
            </section>

            {radarRows.length > 0 && (
              <CompositeRadarTable
                rows={radarRows}
                selectedSignalKey={selectedSignal ? signalKey(selectedSignal) : null}
                searchTerm={searchTerm}
                onSearch={setSearchTerm}
                onSelect={(row) => setSelectedKey(primarySignalKey(row))}
                onOpen={openCompositeDecision}
              />
            )}

            <section className="overflow-hidden rounded-xl border border-card-border bg-card">
              <div className="flex flex-col gap-3 border-b border-card-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-sm font-bold text-text-heading">Ranked Swing Queue</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Click a name to inspect. Use Open Cockpit only when the setup is worth a full decision view.
                  </div>
                </div>
                <div className="relative w-full lg:w-[300px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <input
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Search symbol, phase, reason..."
                    className="h-9 w-full rounded-lg border border-card-border bg-page-bg pl-9 pr-3 text-xs text-text-heading outline-none transition-colors placeholder:text-muted focus:border-accent"
                  />
                </div>
              </div>
              <div className="max-h-[560px] overflow-auto">
                <table className="w-full min-w-[980px] text-xs">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-card-border/50 text-muted">
                      <th className="px-4 py-2 text-left">Symbol</th>
                      <th className="px-2 py-2 text-left">State</th>
                      <th className="px-2 py-2 text-left">Setup / Thesis</th>
                      <th className="px-2 py-2 text-right">Score</th>
                      <th className="px-2 py-2 text-right">Entry</th>
                      <th className="px-2 py-2 text-right">Stop</th>
                      <th className="px-2 py-2 text-right">Target</th>
                      <th className="px-2 py-2 text-right">Risk</th>
                      <th className="px-2 py-2 text-right">R/R</th>
                      <th className="px-4 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {visibleSignals.map((signal) => {
                      const phase = getSwingPhase(signal);
                      const isSelected = selectedSignal && signalKey(signal) === signalKey(selectedSignal);
                      return (
                        <tr
                          key={signalKey(signal)}
                          onClick={() => setSelectedKey(signalKey(signal))}
                          className={cn(
                            "cursor-pointer border-b border-card-border/20 transition-colors hover:bg-hover-bg",
                            isSelected && "bg-accent/5",
                          )}
                        >
                          <td className="px-4 py-3">
                            <button type="button" onClick={() => setSelectedKey(signalKey(signal))} aria-pressed={!!isSelected} className="font-semibold text-text-heading hover:text-accent">{signal.symbol}</button>
                            <div className={cn("text-[11px]", scoreTone(signal))}>{formatPct(signal.change_pct)}</div>
                          </td>
                          <td className="px-2 py-3">
                            <span className={cn("inline-flex rounded-full px-2 py-1 text-[10px] font-extrabold ring-1", phaseToneClass(phase))}>
                              {SWING_PHASE_META[phase].short.toUpperCase()}
                            </span>
                            <div className="mt-1 text-[11px] text-muted">{decisionLabel(signal)}</div>
                          </td>
                          <td className="px-2 py-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", signal.signal === "BULL" ? "bg-profit-bg text-profit" : "bg-loss-bg text-loss")}>
                                {signal.signal}
                              </span>
                              <span className="font-semibold text-text-heading">{STRATEGY_LABELS[signal.strategy]}</span>
                              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", qualityClass(signal.quality))}>
                                {signal.quality || "WATCH"}
                              </span>
                              {typeof signal.rvol === "number" && (
                                <span className="rounded bg-page-bg px-1.5 py-0.5 text-[10px] font-bold text-muted">RVOL {signal.rvol.toFixed(1)}x</span>
                              )}
                            </div>
                            <div className="mt-1 max-w-[440px] truncate text-[11px] text-muted">{signal.notes}</div>
                          </td>
                          <td className={cn("px-2 py-3 text-right font-bold", scoreTone(signal))}>{Math.round(signal.strength)}</td>
                          <td className="px-2 py-3 text-right">{formatNumber(signal.entry_price || signal.current_price)}</td>
                          <td className="px-2 py-3 text-right text-loss">{formatNumber(signal.stop_loss)}</td>
                          <td className="px-2 py-3 text-right text-profit">{formatNumber(signal.target)}</td>
                          <td className="px-2 py-3 text-right">{(signal.risk_pct || 0).toFixed(1)}%</td>
                          <td className="px-2 py-3 text-right">{(signal.rr || 0).toFixed(1)}x</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                openSwingDecision(signal);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-card-border px-2.5 py-1.5 text-[11px] font-bold text-text-heading transition-colors hover:border-accent hover:text-accent"
                            >
                              Open <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {visibleSignals.length === 0 && (
                      <tr>
                        <td colSpan={10} className="py-10 text-center text-muted">
                          No swing setups match this filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {PANELS.map((panel) => {
                const signals = filterSignals(data.strategies[panel.key] || []);
                return (
                  <StrategyMiniPanel
                    key={panel.key}
                    panel={panel}
                    signals={signals}
                    health={strategyHealthByKey.get(panel.key)}
                    selectedKey={selectedSignal ? signalKey(selectedSignal) : null}
                    onSelect={(signal) => setSelectedKey(signalKey(signal))}
                  />
                );
              })}
            </section>
          </div>

          <SelectedSwingPanel signal={selectedSignal} onOpen={openSwingDecision} noTradeReason={data.no_trade_reason} />
        </div>
      )}
    </div>
  );
}

function toRadarCandidate(signal: SwingSignal) {
  const bias = signal.signal === "BULL" ? "LONG" : "SHORT";
  const entry = signal.entry_price || signal.current_price;
  const stop = signal.stop_loss || null;
  const target = signal.target || null;
  return {
    researchOnly: true,
    symbol: signal.symbol,
    bias,
    score: Math.round(signal.strength || 0),
    quality: signal.quality === "A+" ? "A_PLUS" : signal.quality === "A" ? "A" : signal.quality === "B" ? "B" : "WATCH",
    action: (signal.quality === "A+" && (signal.strength || 0) >= 86) ? "ACTIONABLE" : "CONFIRM",
    setups: [signal.strategy, signal.setup_phase || "SWING"],
    entry,
    stop,
    target1: target,
    target2: null,
    riskReward: signal.rr || null,
    invalidation: stop ? `${bias} swing invalidates beyond ${formatNumber(stop)}.` : "No valid swing stop available.",
    ltp: signal.current_price,
    changePct: signal.change_pct,
    volume: 0,
    volRatio: signal.rvol || 0,
    rFactor: signal.rr || 0,
    vwap: null,
    pdh: null,
    pdl: null,
    sector: "Swing Spectrum",
    freshness: { status: "unknown", ageSeconds: null },
    dataWarnings: ["Swing setup adapted into the intraday decision cockpit."],
    reasons: [signal.notes, ...(signal.reasons || [])].filter(Boolean),
  };
}

function toRadarCandidateFromComposite(row: SwingRadarRow) {
  const signal = row.primary_signal;
  const bias = row.direction === "SHORT" ? "SHORT" : row.direction === "LONG" ? "LONG" : "NEUTRAL";
  const entry = row.entry || signal?.entry_price || signal?.current_price || row.current_price || 0;
  const stop = row.stop || signal?.stop_loss || null;
  const target = row.target || signal?.target || null;
  return {
    researchOnly: true,
    symbol: row.symbol,
    bias,
    score: Math.round(row.score || signal?.strength || 0),
    quality: row.score >= 86 ? "A_PLUS" : row.score >= 76 ? "A" : row.score >= 66 ? "B" : "WATCH",
    action: row.action === "PLAN_ENTRY" ? "ACTIONABLE" : row.action === "AVOID_CHASE" ? "WAIT" : "CONFIRM",
    setups: [row.phase, ...(row.strategies || [])],
    entry,
    stop,
    target1: target,
    target2: null,
    riskReward: row.risk_reward || signal?.rr || null,
    invalidation: stop ? `${bias} swing invalidates beyond ${formatNumber(stop)}.` : "No valid swing stop available.",
    ltp: row.current_price || signal?.current_price || entry,
    changePct: row.change_pct || signal?.change_pct || 0,
    volume: 0,
    volRatio: signal?.rvol || 0,
    rFactor: row.risk_reward || signal?.rr || 0,
    vwap: null,
    pdh: null,
    pdl: null,
    sector: "Composite Swing Radar",
    freshness: { status: "unknown", ageSeconds: null },
    dataWarnings: ["Swing research uses the primary thesis; live execution freshness is unverified."],
    reasons: [...(row.evidence || []), ...(row.risks || [])].filter(Boolean),
  };
}

function actionLabel(action: string) {
  if (action === "PLAN_ENTRY") return "Plan entry";
  if (action === "BUILD_WATCH") return "Build watch";
  if (action === "CONFIRM_TAPE") return "Confirm tape";
  if (action === "WAIT_TRIGGER") return "Wait trigger";
  if (action === "AVOID_CHASE") return "Avoid chase";
  if (action === "WAIT_CONFLICT") return "Conflict";
  return "Watch";
}

function actionTone(action: string) {
  if (action === "PLAN_ENTRY") return "bg-profit text-white";
  if (action === "BUILD_WATCH") return "bg-accent text-white";
  if (action === "CONFIRM_TAPE") return "bg-warning text-white";
  if (action === "AVOID_CHASE" || action === "WAIT_CONFLICT") return "bg-loss text-white";
  return "bg-card-border text-text-heading";
}

function CompositeRadarTable({
  rows,
  selectedSignalKey,
  searchTerm,
  onSearch,
  onSelect,
  onOpen,
}: {
  rows: SwingRadarRow[];
  selectedSignalKey: string | null;
  searchTerm: string;
  onSearch: (value: string) => void;
  onSelect: (row: SwingRadarRow) => void;
  onOpen: (row: SwingRadarRow) => void;
}) {
  const visible = useMemo(() => {
    const query = searchTerm.trim().toUpperCase();
    if (!query) return rows;
    return rows.filter((row) => {
      const haystack = [
        row.symbol,
        row.direction,
        row.phase,
        row.action,
        ...(row.strategies || []),
        ...(row.evidence || []),
        ...(row.risks || []),
      ].join(" ").toUpperCase();
      return haystack.includes(query);
    });
  }, [rows, searchTerm]);

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex flex-col gap-3 border-b border-card-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-text-heading">Composite Swing Radar</span>
            <span className="rounded-full bg-accent-bg px-2 py-1 text-[10px] font-extrabold text-accent">
              {rows.length} symbols
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            One ranked row per stock, merged from all swing strategy votes.
          </div>
        </div>
        <div className="relative w-full lg:w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            value={searchTerm}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search symbol, strategy, evidence..."
            className="h-9 w-full rounded-lg border border-card-border bg-page-bg pl-9 pr-3 text-xs text-text-heading outline-none transition-colors placeholder:text-muted focus:border-accent"
          />
        </div>
      </div>
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full min-w-[1060px] text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-card-border/50 text-muted">
              <th className="px-4 py-2 text-left">Symbol</th>
              <th className="px-2 py-2 text-left">Decision</th>
              <th className="px-2 py-2 text-left">Strategy Votes</th>
              <th className="px-2 py-2 text-left">Evidence</th>
              <th className="px-2 py-2 text-right">Score</th>
              <th className="px-2 py-2 text-right">Entry</th>
              <th className="px-2 py-2 text-right">Stop</th>
              <th className="px-2 py-2 text-right">Target</th>
              <th className="px-2 py-2 text-right">R/R</th>
              <th className="px-4 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {visible.map((row) => {
              const selected = selectedSignalKey && primarySignalKey(row) === selectedSignalKey;
              return (
                <tr
                  key={radarRowKey(row)}
                  onClick={() => onSelect(row)}
                  className={cn(
                    "cursor-pointer border-b border-card-border/20 transition-colors hover:bg-hover-bg",
                    selected && "bg-accent/5",
                  )}
                >
                  <td className="px-4 py-3">
                    <div className="font-bold text-text-heading">{row.symbol}</div>
                    <div className={cn("text-[11px]", row.direction === "SHORT" ? "text-loss" : row.direction === "LONG" ? "text-profit" : "text-muted")}>
                      {row.direction} {formatPct(row.change_pct)}
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <span className={cn("inline-flex rounded-full px-2 py-1 text-[10px] font-extrabold ring-1", phaseToneClass(row.phase))}>
                      {SWING_PHASE_META[row.phase]?.short?.toUpperCase() || row.phase}
                    </span>
                    <div className="mt-1 text-[11px] text-muted">{SWING_PHASE_META[row.phase]?.action || "Watch"}</div>
                  </td>
                  <td className="px-2 py-3">
                    <div className="flex max-w-[260px] flex-wrap gap-1">
                      {row.votes.slice(0, 5).map((vote) => (
                        <span
                          key={`${row.symbol}-${vote.strategy}-${vote.signal}`}
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-bold",
                            vote.signal === "BULL" ? "bg-profit-bg text-profit" : "bg-loss-bg text-loss",
                          )}
                        >
                          {STRATEGY_LABELS[vote.strategy] || vote.strategy} {Math.round(vote.score || 0)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <div className="max-w-[300px] truncate text-[11px] text-muted">{row.evidence?.[0] || row.primary_signal?.notes || "-"}</div>
                    <div className="mt-1 max-w-[300px] truncate text-[10px] text-warning">{row.risks?.[0]}</div>
                  </td>
                  <td className={cn("px-2 py-3 text-right font-bold", row.direction === "SHORT" ? "text-loss" : "text-profit")}>{Math.round(row.score)}</td>
                  <td className="px-2 py-3 text-right">{formatNumber(row.entry)}</td>
                  <td className="px-2 py-3 text-right text-loss">{formatNumber(row.stop)}</td>
                  <td className="px-2 py-3 text-right text-profit">{formatNumber(row.target)}</td>
                  <td className="px-2 py-3 text-right">{(row.risk_reward || 0).toFixed(1)}x</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(row);
                      }}
                      className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold", actionTone(row.action))}
                    >
                      {actionLabel(row.action)} <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="py-10 text-center text-muted">
                  No composite swing rows match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  tone,
}: {
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  tone?: (value: T) => "accent" | "profit" | "loss" | "warning";
}) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-card-border bg-page-bg p-0.5">
      {options.map((option) => {
        const active = option.key === value;
        const activeTone = tone?.(option.key) || "accent";
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            disabled={disabled}
            className={cn(
              "h-8 rounded-md px-2.5 text-xs font-bold transition-colors disabled:opacity-50",
              active
                ? activeTone === "profit"
                  ? "bg-profit text-white"
                  : activeTone === "loss"
                    ? "bg-loss text-white"
                    : activeTone === "warning"
                      ? "bg-warning text-white"
                      : "bg-accent text-white"
                : "text-muted hover:text-text-heading",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function DeskStat({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  sub: string;
  tone?: "accent" | "profit" | "loss" | "warning";
}) {
  return (
    <div className="flex min-h-[82px] items-center gap-3 px-4 py-3">
      <span
        className={cn(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          tone === "profit"
            ? "bg-profit-bg text-profit"
            : tone === "loss"
              ? "bg-loss-bg text-loss"
              : tone === "warning"
                ? "bg-warning/10 text-warning"
                : "bg-accent-bg text-accent",
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
        <div className="truncate text-sm font-bold text-text-heading">{value}</div>
        <div className="truncate text-[11px] text-muted">{sub}</div>
      </div>
    </div>
  );
}

function PhaseCard({
  phase,
  count,
  active,
  top,
}: {
  phase: SwingPhaseKey;
  count: number;
  active: boolean;
  top?: SwingSignal;
}) {
  const meta = SWING_PHASE_META[phase];
  return (
    <div className={cn("rounded-xl border border-card-border bg-card p-4 transition-colors", active && "bg-accent-bg/30 shadow-sm")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cn("text-[11px] font-extrabold uppercase tracking-wide", phaseToneClass(phase, "text"))}>{meta.label}</div>
          <div className="mt-1 text-2xl font-bold text-text-heading">{count}</div>
        </div>
        <span className={cn("rounded-full px-2 py-1 text-[10px] font-extrabold ring-1", phaseToneClass(phase))}>{meta.action}</span>
      </div>
      <p className="mt-2 min-h-[44px] text-[11px] leading-relaxed text-muted">{meta.desc}</p>
      {top ? (
        <div className="mt-3 rounded-lg bg-page-bg/70 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-text-heading">{top.symbol}</span>
            <span className={scoreTone(top)}>{formatPct(top.change_pct)}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted">{STRATEGY_LABELS[top.strategy]} / Score {Math.round(top.strength)}</div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-page-bg/50 px-3 py-2 text-[11px] text-muted">No names in this state.</div>
      )}
    </div>
  );
}

function StrategyMemoryStrip({
  rows,
  loading,
  error,
}: {
  rows: SwingStrategyHealthRow[];
  loading: boolean;
  error: string | null;
}) {
  const visibleRows = rows.slice(0, 6);
  const placeholderRows = PANELS.slice(0, 6).map((panel) => ({
    key: panel.key,
    label: panel.label,
  }));

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex flex-col gap-2 border-b border-card-border px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-bold text-text-heading">30D Strategy Memory</div>
          <div className="mt-0.5 text-xs text-muted">
            Outcome-backed swing playbooks, ranked by follow-through.
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          {loading ? "Loading outcomes" : error ? "Memory unavailable" : `${rows.length} playbooks tracked`}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-0 divide-y divide-card-border md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-6">
        {loading && placeholderRows.map((row) => (
          <StrategyMemoryCard key={row.key} label={row.label} />
        ))}
        {!loading && visibleRows.map((row) => (
          <StrategyMemoryCard key={row.key} row={row} label={row.label} />
        ))}
        {!loading && visibleRows.length === 0 && placeholderRows.map((row) => (
          <StrategyMemoryCard key={row.key} label={row.label} error={error} />
        ))}
      </div>
    </section>
  );
}

function StrategyMemoryCard({ row, label, error }: { row?: SwingStrategyHealthRow; label: string; error?: string | null }) {
  const stats = row?.preferred;
  const verdict = stats?.edge;
  const verdictLabel = verdict?.label || "NEEDS_SAMPLE";
  return (
    <div className="min-h-[132px] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-extrabold uppercase tracking-wide text-text-heading">{label}</div>
          <div className="mt-1 text-[11px] text-muted">
            {row ? `${row.fires} fires / ${row.symbol_count} names` : error ? "Waiting for access" : "Learning"}
          </div>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold", memoryEdgeClass(verdictLabel))}>
          {memoryEdgeLabel(verdictLabel)}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-muted">Win</div>
          <div className={cn("font-mono font-bold", memoryRateTone(stats?.win_rate))}>{formatMemoryPct(stats?.win_rate)}</div>
        </div>
        <div>
          <div className="text-muted">Avg</div>
          <div className={cn("font-mono font-bold", memoryReturnTone(stats?.avg_return_pct))}>{formatMemorySigned(stats?.avg_return_pct)}</div>
        </div>
        <div>
          <div className="text-muted">N</div>
          <div className="font-mono font-bold text-text-heading">{stats ? `${stats.resolved}/${stats.total}` : "-"}</div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{row ? memoryHorizonLabel(row.preferred_horizon) : "shadow mode"}</span>
        <span className="truncate" title={verdict?.reason}>{verdict?.action || "Need resolved outcomes"}</span>
      </div>
    </div>
  );
}

function EmptySwingState({ onReplay, onScan }: { onReplay: () => void; onScan: () => void }) {
  return (
    <section className="rounded-xl border border-card-border bg-card p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-accent-bg text-accent">
        <TrendingUp className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="mt-4 text-lg font-bold text-text-heading">Load a swing radar</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Start with Replay for the last good snapshot. Use Scan Swing when market data is healthy and you want the latest daily-candle classification.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onReplay} className="rounded-lg border border-card-border px-4 py-2 text-sm font-bold text-text-heading hover:border-accent hover:text-accent">
          Load Replay
        </button>
        <button type="button" onClick={onScan} className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent/85">
          Scan Swing
        </button>
      </div>
    </section>
  );
}

function StrategyMiniPanel({
  panel,
  signals,
  health,
  selectedKey,
  onSelect,
}: {
  panel: (typeof PANELS)[number];
  signals: SwingSignal[];
  health?: SwingStrategyHealthRow;
  selectedKey: string | null;
  onSelect: (signal: SwingSignal) => void;
}) {
  const healthStats = health?.preferred;
  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-card-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-bold text-text-heading">{panel.label}</div>
          <div className="truncate text-[11px] text-muted">{panel.desc}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs font-semibold text-muted">{signals.length}</div>
          {healthStats && (
            <div className={cn("mt-1 text-[10px] font-bold", memoryRateTone(healthStats.win_rate))}>
              {formatMemoryPct(healthStats.win_rate)} win
            </div>
          )}
        </div>
      </div>
      <div className="max-h-[230px] overflow-auto">
        {signals.slice(0, 12).map((signal) => {
          const phase = getSwingPhase(signal);
          const active = selectedKey === signalKey(signal);
          return (
            <button
              key={signalKey(signal)}
              type="button"
              onClick={() => onSelect(signal)}
              className={cn("flex w-full items-center justify-between gap-3 border-b border-card-border/20 px-4 py-2 text-left text-xs hover:bg-hover-bg", active && "bg-accent/5")}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-text-heading">{signal.symbol}</span>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", phaseToneClass(phase))}>{SWING_PHASE_META[phase].short}</span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted">{signal.notes}</div>
              </div>
              <div className="shrink-0 text-right font-mono">
                <div className={cn("font-bold", scoreTone(signal))}>{Math.round(signal.strength)}</div>
                <div className="text-[10px] text-muted">{(signal.rr || 0).toFixed(1)}x</div>
              </div>
            </button>
          );
        })}
        {signals.length === 0 && <div className="px-4 py-8 text-center text-xs text-muted">No setups</div>}
      </div>
    </div>
  );
}

function SelectedSwingPanel({
  signal,
  onOpen,
  noTradeReason,
}: {
  signal: SwingSignal | null;
  onOpen: (signal: SwingSignal) => void;
  noTradeReason?: string | null;
}) {
  if (!signal) {
    return (
      <aside className="rounded-xl border border-card-border bg-card p-6">
        <div className="text-sm font-bold text-text-heading">Selected Swing Thesis</div>
        <p className="mt-2 text-sm leading-relaxed text-muted">{noTradeReason || "No swing setup passed the current quality checks."}</p>
      </aside>
    );
  }

  const phase = getSwingPhase(signal);
  const meta = SWING_PHASE_META[phase];
  const trigger = signal.entry_price || signal.breakout_level || signal.current_price;

  return (
    <aside className="xl:sticky xl:top-24 xl:self-start">
      <div className="overflow-hidden rounded-xl border border-card-border bg-card">
        <div className="border-b border-card-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Selected Swing Thesis</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h3 className="text-2xl font-bold text-text-heading">{signal.symbol}</h3>
                <span className={cn("rounded px-2 py-1 text-[10px] font-extrabold", signal.signal === "BULL" ? "bg-profit-bg text-profit" : "bg-loss-bg text-loss")}>
                  {signal.signal}
                </span>
                <span className={cn("rounded px-2 py-1 text-[10px] font-extrabold", qualityClass(signal.quality))}>{signal.quality || "WATCH"}</span>
                {signal.lifecycle_state && (
                  <span className="rounded bg-page-bg px-2 py-1 text-[10px] font-extrabold text-muted ring-1 ring-card-border">
                    {signal.lifecycle_state.replaceAll("_", " ")}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted">
                {STRATEGY_LABELS[signal.strategy]} / {formatHold(signal)} / {signal.trigger_date}
              </div>
            </div>
            <div className="text-right">
              <div className={cn("text-3xl font-extrabold", scoreTone(signal))}>{Math.round(signal.strength)}</div>
              <div className="text-[11px] text-muted">score</div>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-card-border bg-page-bg/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1", phaseToneClass(phase))}>{meta.label}</span>
              <span className="text-xs font-bold text-text-heading">{decisionLabel(signal)}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{thesisText(signal)}</p>
          </div>
        </div>

        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Metric label="LTP" value={formatNumber(signal.current_price)} />
            <Metric label="Trigger" value={formatNumber(trigger)} />
            <Metric label="Stop" value={formatNumber(signal.stop_loss)} tone="loss" />
            <Metric label="Target" value={formatNumber(signal.target)} tone="profit" />
            <Metric label="Risk" value={formatPct(signal.risk_pct ? -signal.risk_pct : undefined)} tone="loss" />
            <Metric label="Reward" value={formatPct(signal.reward_pct)} tone="profit" />
            <Metric label="R/R" value={`${(signal.rr || 0).toFixed(1)}x`} />
            <Metric label="RVOL" value={signal.rvol ? `${signal.rvol.toFixed(1)}x` : "-"} tone={signal.rvol && signal.rvol >= 1.5 ? "profit" : undefined} />
            <Metric
              label="N500 RS 20D"
              value={signal.benchmark_rs_20 == null ? "Unknown" : `${signal.benchmark_rs_20 >= 0 ? "+" : ""}${signal.benchmark_rs_20.toFixed(1)} pp`}
              tone={(signal.benchmark_rs_20 || 0) >= 2 ? "profit" : (signal.benchmark_rs_20 || 0) <= -2 ? "loss" : undefined}
            />
            <Metric
              label="N500 RS 60D"
              value={signal.benchmark_rs_60 == null ? "Unknown" : `${signal.benchmark_rs_60 >= 0 ? "+" : ""}${signal.benchmark_rs_60.toFixed(1)} pp`}
              tone={(signal.benchmark_rs_60 || 0) >= 3 ? "profit" : (signal.benchmark_rs_60 || 0) <= -3 ? "loss" : undefined}
            />
            <Metric label="Weekly" value={signal.weekly_trend || "MIXED"} />
            <Metric
              label="To trigger"
              value={`${(signal.distance_to_trigger_pct || 0) >= 0 ? "+" : ""}${(signal.distance_to_trigger_pct || 0).toFixed(1)}%`}
            />
            <Metric
              label="Extension"
              value={`${(signal.extension_atr || 0).toFixed(1)} ATR`}
              tone={(signal.extension_atr || 0) >= 2.5 ? "loss" : undefined}
            />
          </div>

          <div className="space-y-2 rounded-xl border border-card-border bg-page-bg/50 p-3">
            <div className="text-xs font-bold text-text-heading">Quality Stack</div>
            <QualityBar label="Trend" value={signal.trend_score || 0} />
            <QualityBar label="Volume" value={signal.volume_score || 0} />
            <QualityBar label="Pattern" value={signal.pattern_score || 0} />
          </div>

          <div className="rounded-xl border border-card-border bg-page-bg/50 p-3">
            <div className="text-xs font-bold text-text-heading">Execution Checklist</div>
            <div className="mt-2 space-y-2 text-xs">
              <ChecklistLine label="Phase" value={meta.action} />
              <ChecklistLine label="Entry" value={`Above/near ${formatNumber(trigger)}`} />
              <ChecklistLine label="Invalidation" value={`Beyond ${formatNumber(signal.stop_loss)}`} danger />
              <ChecklistLine label="Position risk" value={`${(signal.risk_pct || 0).toFixed(1)}% to stop`} />
            </div>
          </div>

          {signal.reasons && signal.reasons.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {signal.reasons.slice(0, 6).map((reason) => (
                <span key={reason} className="rounded-full bg-accent/10 px-2 py-1 text-[11px] font-semibold text-accent">
                  {reason}
                </span>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => onOpen(signal)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-accent/85"
          >
            Open Decision Cockpit <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "profit" | "loss" }) {
  return (
    <div className="bg-page-bg/60 rounded px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cn("text-sm font-bold", tone === "profit" && "text-profit", tone === "loss" && "text-loss")}>{value}</div>
    </div>
  );
}

function QualityBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-bold text-text-heading">{Math.round(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-card-border/40">
        <div className="h-full rounded-full bg-accent" style={{ width: confidenceWidth(value) }} />
      </div>
    </div>
  );
}

function ChecklistLine({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={cn("text-right font-semibold text-text-heading", danger && "text-loss")}>{value}</span>
    </div>
  );
}
