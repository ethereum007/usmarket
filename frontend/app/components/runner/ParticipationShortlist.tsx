"use client";

import { ArrowDownRight, ArrowUpRight, CircleDashed, Crosshair, Eye, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ParticipationUniverse, RunnerRankingCandidate, RunnerRankingResponse, RunnerRankingTier } from "./types";

const UNIVERSES: { value: ParticipationUniverse; label: string; helper: string }[] = [
  { value: "nifty100", label: "Nifty 100", helper: "large-cap" },
  { value: "nifty500", label: "Nifty 500", helper: "broad market" },
  { value: "smallcap", label: "Smallcap 250", helper: "higher beta" },
  { value: "broad", label: "All monitored", helper: "combined" },
];

const TIER_LABELS: Record<RunnerRankingTier, string> = {
  HIGH_QUALITY: "High quality",
  RUNNER_CANDIDATE: "Runner candidate",
  STATISTICALLY_UNUSUAL: "Unusual",
  OBSERVE: "Observe",
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function ratio(value: number | null | undefined) {
  return finite(value) ? `${value.toFixed(2)}x` : "—";
}

function percent(value: number | null | undefined) {
  if (!finite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function DirectionIcon({ direction }: { direction: RunnerRankingCandidate["direction"] }) {
  if (direction === "UP") return <ArrowUpRight aria-hidden="true" className="h-4 w-4" />;
  if (direction === "DOWN") return <ArrowDownRight aria-hidden="true" className="h-4 w-4" />;
  return <CircleDashed aria-hidden="true" className="h-4 w-4" />;
}

function tierTone(tier: RunnerRankingTier) {
  if (tier === "HIGH_QUALITY") return "border-profit/35 bg-profit-bg text-profit";
  if (tier === "RUNNER_CANDIDATE") return "border-accent/35 bg-accent-bg text-accent";
  if (tier === "STATISTICALLY_UNUSUAL") return "border-warning/35 bg-warning/10 text-warning";
  return "border-card-border bg-surface-subtle text-muted";
}

function CandidateCard({ candidate, onInspect }: { candidate: RunnerRankingCandidate; onInspect: (symbol: string) => void }) {
  const directionClass = candidate.direction === "UP"
    ? "border-profit/30 bg-profit-bg text-profit"
    : candidate.direction === "DOWN"
      ? "border-loss/30 bg-loss-bg text-loss"
      : "border-card-border bg-surface-subtle text-muted";
  const qualified = candidate.tier === "HIGH_QUALITY" || candidate.tier === "RUNNER_CANDIDATE";

  return (
    <button
      type="button"
      onClick={() => onInspect(candidate.symbol)}
      className={cn(
        "group min-w-0 cursor-pointer rounded-xl border bg-card p-4 text-left shadow-sm outline-none transition motion-reduce:transform-none",
        "hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-accent",
        qualified ? "border-accent/30 hover:border-accent/60" : "border-card-border hover:border-card-border/80",
      )}
      aria-label={`Inspect Runner evidence for ${candidate.symbol}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent-bg font-mono text-sm font-black text-accent">#{candidate.rank}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-lg font-black text-text-heading">{candidate.symbol}</span>
              <span className={cn("rounded-md border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide", tierTone(candidate.tier))}>{TIER_LABELS[candidate.tier]}</span>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted">{candidate.sector || "Sector unavailable"} · ₹{candidate.ltp.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
          </div>
        </div>
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-black", directionClass)}>
          <DirectionIcon direction={candidate.direction} />{candidate.direction}
        </span>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3 rounded-lg border border-card-border bg-surface-subtle p-3">
        <div>
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-muted">Runner score</div>
          <div className="mt-1 font-mono text-3xl font-black text-text-heading">{candidate.runnerScore.toFixed(1)}</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-muted">Cross-section</div>
          <div className="mt-1 font-mono text-sm font-black text-accent">Top {Math.max(1, Math.round(100 - candidate.crossSectionPercentile))}%</div>
          <div className="mt-0.5 text-[10px] text-muted">{Math.round(candidate.evidenceCompleteness * 100)}% evidence</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Evidence label="RVOL TOD" value={ratio(candidate.rvolTod20d)} strong />
        <Evidence label="RVOL 5m" value={ratio(candidate.rvol5m)} />
        <Evidence label="Acceleration" value={ratio(candidate.volumeAcceleration)} />
        <Evidence label="Return 5m" value={percent(candidate.ret5m)} tone={candidate.ret5m} />
        <Evidence label="Range TOD" value={ratio(candidate.rangeTodRatio)} />
        <Evidence label="Turnover" value={`₹${candidate.turnoverCrore.toFixed(1)}Cr`} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-1" aria-label="Runner score components">
        {Object.entries(candidate.components).map(([label, value]) => (
          <div key={label} className="rounded-md border border-card-border px-2 py-1.5">
            <div className="truncate text-[8px] font-bold uppercase tracking-wide text-muted">{label}</div>
            <div className="mt-0.5 font-mono text-[11px] font-black text-foreground">{value.toFixed(1)}</div>
          </div>
        ))}
      </div>

      <ul className="mt-3 space-y-1.5">
        {candidate.reasons.slice(0, 3).map((reason) => (
          <li key={reason} className="flex gap-2 text-xs leading-5 text-muted"><span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />{reason}</li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-between border-t border-card-border pt-3 text-[10px] font-bold uppercase tracking-wide text-muted">
        <span>{candidate.dataSource} · {Math.round(candidate.freshnessSeconds)}s old</span>
        <span className="inline-flex items-center gap-1 text-accent"><Eye aria-hidden="true" className="h-3.5 w-3.5" />Inspect</span>
      </div>
    </button>
  );
}

function Evidence({ label, value, strong = false, tone }: { label: string; value: string; strong?: boolean; tone?: number | null }) {
  const toneClass = finite(tone) ? tone > 0 ? "text-profit" : tone < 0 ? "text-loss" : "text-text-heading" : strong ? "text-accent" : "text-text-heading";
  return <div className="min-w-0"><div className="truncate text-[9px] font-bold uppercase tracking-wide text-muted">{label}</div><div className={cn("mt-1 truncate font-mono text-sm font-black", toneClass)}>{value}</div></div>;
}

export function RunnerRankingPanel({ data, universe, onUniverseChange, onInspect, baselineCoverage }: {
  data: RunnerRankingResponse | null;
  universe: ParticipationUniverse;
  onUniverseChange: (universe: ParticipationUniverse) => void;
  onInspect: (symbol: string) => void;
  baselineCoverage: number;
}) {
  const rankings = data?.rankings || [];
  const calibrating = baselineCoverage < 80;
  const hasCandidates = (data?.candidateCount || 0) > 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-card-border bg-[radial-gradient(circle_at_top_left,var(--accent-bg),transparent_34rem),var(--card)] shadow-[0_18px_60px_rgba(0,0,0,0.12)]">
      <div className="flex flex-col gap-4 border-b border-card-border p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent-bg text-accent"><Crosshair aria-hidden="true" className="h-5 w-5" /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black text-text-heading">Runner Research Ranking</h2>
              <span className="rounded-full border border-accent/25 bg-accent-bg px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-accent">Intraday live</span>
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-warning">Not entry ready</span>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">Top five live leaders across participation, volume velocity, price, range, structure, and market context. A rank is evidence—not permission to enter.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Runner ranking universe">
          {UNIVERSES.map((option) => (
            <button key={option.value} type="button" onClick={() => onUniverseChange(option.value)} aria-pressed={universe === option.value} className={cn("min-h-11 cursor-pointer rounded-lg border px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:ring-accent", universe === option.value ? "border-accent/40 bg-accent-bg text-accent" : "border-card-border bg-card text-muted hover:bg-surface-hover")}>
              <span className="block text-xs font-black">{option.label}</span><span className="mt-0.5 block text-[9px] uppercase tracking-wide opacity-75">{option.helper}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {rankings.length ? (
          <>
            {!hasCandidates ? (
              <div className="mb-4 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-3" role="status">
                <ShieldAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <div><div className="text-sm font-black text-text-heading">No qualified Runner candidate right now</div><p className="mt-0.5 text-xs leading-5 text-muted">The names below are the strongest research observations, but none cleared the candidate gates. No trade is the correct output.</p></div>
              </div>
            ) : null}
            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-5">
              {rankings.map((candidate) => <CandidateCard key={candidate.symbol} candidate={candidate} onInspect={onInspect} />)}
            </div>
          </>
        ) : (
          <div className="flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed border-card-border bg-surface-subtle px-5 py-6 text-center">
            {calibrating ? <ShieldAlert aria-hidden="true" className="h-8 w-8 text-warning" /> : <ShieldCheck aria-hidden="true" className="h-8 w-8 text-accent" />}
            <h3 className="mt-3 text-lg font-black text-text-heading">{calibrating ? "Calibrating same-time baselines" : "No eligible live ranking"}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{calibrating ? `Live data is flowing, but same-minute baseline coverage is ${baselineCoverage.toFixed(1)}%. The engine fails closed until historical evidence is available.` : "No symbol currently has the required fresh baseline, five-minute volume, and liquidity evidence. Nothing is promoted."}</p>
          </div>
        )}

        <div className="mt-4 grid gap-2 rounded-lg border border-card-border bg-surface-subtle px-4 py-3 text-xs text-muted sm:grid-cols-3">
          <span><strong className="font-black text-text-heading">{data?.highQualityCount || 0}</strong> high quality</span>
          <span><strong className="font-black text-text-heading">{data?.candidateCount || 0}</strong> qualified candidates</span>
          <span><strong className="font-black text-text-heading">{data?.eligible || 0}</strong> eligible / {data?.featuresAvailable || 0} live features</span>
        </div>
      </div>
    </section>
  );
}
