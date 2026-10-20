"use client";

import { cn, formatNumber } from "../../lib/utils";
import type { RadarCandidate } from "../pages/PulseContent";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SignalRecommendation {
  strike: number;
  optionType?: "CE" | "PE";
  option_type?: "CE" | "PE";
  tradingsymbol?: string;
  entry: number;
  stopLoss?: number;
  stop_loss?: number;
  target1: number;
  target2: number;
  iv: number | null;
  oi: number;
  volume: number;
  lotSize?: number;
  lot_size?: number;
}

interface CashRecommendation {
  action: "BUY" | "SELL";
  entry: number;
  stopLoss?: number;
  stop_loss?: number;
  target1: number;
  target2: number;
}

interface SignalData {
  symbol: string;
  category: "index" | "stock";
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: "STRONG" | "MODERATE" | "WEAK";
  score: number;
  spot?: number;
  pcr?: number;
  max_pain_strike?: number;
  expiry?: string;
  recommendation: SignalRecommendation | null;
  cashRecommendation?: CashRecommendation | null;
  cash_recommendation?: CashRecommendation | null;
  analytics?: {
    pcr: number;
    pcrSentiment?: string;
    maxPainStrike?: number;
    max_pain_strike?: number;
    maxPainDistance?: number;
    atmIV?: number;
    spot: number;
    prevClose?: number;
    changePct?: number;
    change_pct?: number;
    expiry?: string;
  };
  scoreBreakdown?: Record<string, number>;
  score_breakdown?: Record<string, number>;
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function pick<T>(a: T | undefined, b: T | undefined): T | undefined {
  return a !== undefined ? a : b;
}

const dirCfg = {
  BULLISH:  { label: "BULLISH",  color: "text-profit", bg: "bg-profit/10", border: "border-profit/20", bar: "bg-profit" },
  BEARISH:  { label: "BEARISH",  color: "text-loss",   bg: "bg-loss/10",   border: "border-loss/20",   bar: "bg-loss"   },
  NEUTRAL:  { label: "NEUTRAL",  color: "text-muted",  bg: "bg-card",      border: "border-card-border", bar: "bg-muted" },
};

const confCfg = {
  STRONG:   { label: "STRONG",   color: "text-profit", bg: "bg-profit/10" },
  MODERATE: { label: "MODERATE", color: "text-accent",  bg: "bg-accent/10" },
  WEAK:     { label: "WEAK",     color: "text-muted",   bg: "bg-card"      },
};

const RADAR_CANDIDATE_STORAGE_KEY = "alpha-radar:selected-candidate";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function SignalCard({ signal }: { signal: SignalData }) {
  const dir  = dirCfg[signal.direction]   || dirCfg.NEUTRAL;
  const conf = confCfg[signal.confidence] || confCfg.WEAK;

  const rec  = signal.recommendation;
  const cash = pick(signal.cashRecommendation, signal.cash_recommendation) ?? null;

  const spot    = signal.spot ?? signal.analytics?.spot ?? 0;
  const pcr     = signal.pcr ?? signal.analytics?.pcr ?? 0;
  const maxPain = signal.max_pain_strike ?? signal.analytics?.maxPainStrike ?? signal.analytics?.max_pain_strike ?? 0;
  const expiry  = signal.expiry ?? signal.analytics?.expiry ?? "";

  const recOptionType = rec ? (rec.optionType ?? rec.option_type ?? "CE") : "CE";
  const recSL  = rec ? (rec.stopLoss ?? rec.stop_loss ?? 0) : 0;
  const cashSL = cash ? (cash.stopLoss ?? cash.stop_loss ?? 0) : 0;

  const score    = signal.score ?? 0;
  const absScore = Math.abs(score);
  const isBull   = signal.direction === "BULLISH";
  const isBear   = signal.direction === "BEARISH";
  const radarCandidate = toRadarCandidate(signal, {
    spot,
    cash,
    cashSL,
    score,
    isBull,
    isBear,
  });

  return (
    <div className={cn("bg-card border rounded-lg overflow-hidden", dir.border)}>

      {/* ROW 1: Header — symbol, direction badge, PCR left | score right */}
      <div className="px-3 py-2 flex items-center gap-2">
        {/* Left: symbol + badge + PCR */}
        <a
          href={`/radar-trade?symbol=${encodeURIComponent(signal.symbol)}`}
          onClick={() => persistRadarCandidate(radarCandidate)}
          className="text-sm font-bold text-accent hover:underline tracking-wide"
          title="Open decision cockpit"
        >
          {signal.symbol}
        </a>
        <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase", dir.bg, dir.color)}>
          {dir.label}
        </span>
        <span className="text-xs text-muted ml-1">
          PCR: <span className={cn("font-mono font-medium", pcr > 1.3 ? "text-profit" : pcr < 0.7 ? "text-loss" : "text-foreground")}>{pcr.toFixed(2)}</span>
        </span>

        {/* Right: score bar + score value + confidence */}
        <div className="flex items-center gap-1.5 ml-auto">
          <div className="w-28 h-2.5 bg-card-border/30 rounded-full overflow-hidden relative">
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-muted/50 z-10" />
            {score !== 0 && (
              <div
                className={cn("absolute top-0 bottom-0 rounded-full", dir.bar)}
                style={
                  score > 0
                    ? { left: "50%", width: `${absScore / 2}%` }
                    : { right: "50%", width: `${absScore / 2}%` }
                }
              />
            )}
          </div>
          <span className={cn("text-sm font-mono font-bold", dir.color)}>
            {score > 0 ? "+" : ""}{score}
          </span>
          <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded", conf.bg, conf.color)}>
            {conf.label}
          </span>
        </div>
      </div>

      {/* ROW 2: Spot, Max Pain left | Expiry right */}
      <div className="px-3 pb-1.5 flex items-center gap-4 text-xs text-muted">
        <span>Spot: <span className="font-mono text-foreground">{formatNumber(spot)}</span></span>
        {maxPain > 0 && (
          <span>Max Pain: <span className="font-mono text-foreground">{formatNumber(maxPain, 0)}</span></span>
        )}
        {expiry && (
          <span className="ml-auto">Expiry: <span className="text-foreground">{
            (() => {
              try {
                const d = new Date(expiry);
                return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
              } catch { return expiry; }
            })()
          }</span></span>
        )}
      </div>

      {/* ROW 3: Recommendations — Options left, Cash (Intraday) right */}
      {(rec || cash) && (
        <div className="px-3 py-2 border-t border-card-border/40 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {/* Options — left side */}
          {rec && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted font-semibold uppercase tracking-wider mb-1">Options</div>
              <div className="flex items-center gap-2 font-mono">
                <span className={cn("font-bold text-[11px] px-1.5 py-0.5 rounded",
                  isBull ? "bg-profit text-white" : isBear ? "bg-loss text-white" : "bg-muted text-foreground"
                )}>
                  {isBull ? "BUY" : "SELL"}
                </span>
                <span className="font-medium text-foreground">
                  {signal.symbol} {rec.strike} {recOptionType}
                </span>
                <span className="text-foreground">@ {formatNumber(rec.entry)}</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span><span className="text-loss">SL: </span><span className="text-foreground">{formatNumber(recSL)}</span></span>
                <span><span className="text-profit">T1: </span><span className="text-foreground">{formatNumber(rec.target1)}</span></span>
                <span><span className="text-profit">T2: </span><span className="text-foreground">{formatNumber(rec.target2)}</span></span>
              </div>
            </div>
          )}
          {/* Cash — right side */}
          {cash && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted font-semibold uppercase tracking-wider mb-1">Cash</div>
              <div className="flex items-center gap-2 font-mono">
                <span className={cn("font-bold text-[11px] px-1.5 py-0.5 rounded",
                  cash.action === "BUY" ? "bg-profit text-white" : "bg-loss text-white"
                )}>
                  {cash.action}
                </span>
                <span className="font-medium text-foreground">{signal.symbol}</span>
                <span className="text-foreground">@ {formatNumber(cash.entry)}</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span><span className="text-loss">SL: </span><span className="text-foreground">{formatNumber(cashSL)}</span></span>
                <span><span className="text-profit">T1: </span><span className="text-foreground">{formatNumber(cash.target1)}</span></span>
                <span><span className="text-profit">T2: </span><span className="text-foreground">{formatNumber(cash.target2)}</span></span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ROW 5: Reasons — inline bullets, 2-column grid if many */}
      {signal.reasons && signal.reasons.length > 0 && (
        <div className={cn(
          "px-3 py-1.5 border-t border-card-border/30",
          signal.reasons.length > 3 ? "grid grid-cols-2 gap-x-4 gap-y-0.5" : "flex flex-wrap gap-x-4 gap-y-0.5"
        )}>
          {signal.reasons.slice(0, 6).map((reason, i) => (
            <span key={i} className="flex items-start gap-1.5 text-[11px] text-muted leading-tight">
              <span className={cn("w-1 h-1 rounded-full mt-1.5 shrink-0",
                isBull ? "bg-profit" : isBear ? "bg-loss" : "bg-muted"
              )} />
              {reason}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function persistRadarCandidate(candidate: RadarCandidate) {
  window.sessionStorage.setItem(RADAR_CANDIDATE_STORAGE_KEY, JSON.stringify(candidate));
}

function toRadarCandidate(
  signal: SignalData,
  context: {
    spot: number;
    cash: CashRecommendation | null;
    cashSL: number;
    score: number;
    isBull: boolean;
    isBear: boolean;
  },
): RadarCandidate {
  const bias = context.isBull ? "LONG" : context.isBear ? "SHORT" : "NEUTRAL";
  const entry = context.cash?.entry || context.spot || 0;
  const stop = context.cashSL || null;
  const target = context.cash?.target1 || null;
  const risk = stop && entry ? Math.abs(entry - stop) : 0;
  const reward = target && entry ? Math.abs(target - entry) : 0;

  return {
    symbol: signal.symbol,
    bias,
    score: Math.round(Math.abs(context.score || 0)),
    quality: signal.confidence === "STRONG" ? "A" : signal.confidence === "MODERATE" ? "B" : "WATCH",
    action: bias === "NEUTRAL" ? "WAIT" : signal.confidence === "STRONG" ? "CONFIRM" : "WAIT",
    setups: ["OI_SIGNAL", signal.direction, signal.confidence],
    entry,
    stop,
    target1: target,
    target2: context.cash?.target2 || null,
    riskReward: risk > 0 && reward > 0 ? reward / risk : null,
    invalidation: stop ? `${bias} signal invalidates beyond ${formatNumber(stop)}.` : "No valid signal stop available.",
    ltp: context.spot,
    changePct: signal.analytics?.changePct ?? signal.analytics?.change_pct ?? 0,
    volume: 0,
    volRatio: 0,
    rFactor: risk > 0 && reward > 0 ? reward / risk : 0,
    vwap: null,
    pdh: null,
    pdl: null,
    sector: signal.category === "stock" ? "Stock Signals" : "Index Signals",
    freshness: { status: "fresh", ageSeconds: null },
    dataWarnings: ["OI signal adapted into the standalone decision cockpit."],
    reasons: signal.reasons || [],
  };
}
