"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Activity, ArrowUpDown, ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import { fetchAPI } from "../../lib/api";
import { cn } from "../../lib/utils";
import { comparePriority, entryStatus, priorityFor, type Priority } from "../../lib/intraday-priority";

type SignalType = "FIVE_MIN_BREAKOUT" | "FIFTEEN_MIN_BREAKOUT" | "PREVIOUS_DAY_HIGH_BREAK" | "FIVE_MIN_BREAKDOWN" | "FIFTEEN_MIN_BREAKDOWN" | "PREVIOUS_DAY_LOW_BREAK";
type Basis = "FIVE" | "FIFTEEN" | "PREVIOUS_DAY";
type Direction = "ALL" | "LONG" | "SHORT";
type SortKey = "time" | "high" | "close";
type Sort = { key: SortKey | null; direction: "asc" | "desc" };
type Breakdown = { total: number; components: { label: string; points: number }[]; setups: string[]; inputs: { changePct: number; volRatio: number; rFactor: number }; note: string };
type Assessment = {
  status: string; reason: string; asOf: string; signalAgeMinutes?: number | null;
  quoteAsOf?: string | null; entry?: number | null; confirmationPrice?: number | null;
  stop?: number | null; referenceTarget?: number | null; remainingRewardRisk?: number | null;
  entryDistanceR?: number | null; entryDistancePct?: number | null; targetBasis: string;
  checks: { label: string; passed: boolean }[];
};
type Signal = {
  eventId?: string; eventNumber?: number; isLatest?: boolean;
  type: SignalType; signalTime: string; triggerPrice: number; breakoutLevel?: number | null;
  postConfirmationBestReturnPct?: number | null; postConfirmationCloseReturnPct?: number | null;
  radarScoreAtDetection?: number | null; detectedAt?: string | null;
  radarBreakdownAtDetection?: Breakdown | null; entryAssessment?: Assessment;
};
type Candidate = {
  symbol: string; direction: "LONG" | "SHORT"; isFno?: boolean; ltp?: number | null;
  changePct?: number | null; score?: number | null; scoreBreakdown?: Breakdown | null;
  radarAsOf?: string | number | null; radarBias?: string; tags: string[]; signals: Signal[]; events?: Signal[];
};
export type IntradayResponse = {
  status?: string; stale?: boolean; generatedAt?: string | null; timestamp: number; marketHours: boolean;
  summary: { signalCandidates: number; bullishSignals: number; bearishSignals: number; fiveMinute: number; fifteenMinute: number; previousDayHigh: number; previousDayLow: number };
  candidates: Candidate[];
  coverage?: { universe?: string; requested?: number | null; quoted?: number | null; missingQuotes?: number | null;
    ranked?: number; fullScan?: boolean; eligible?: number; monitored?: number; completeCandles?: number;
    pendingCandles?: number; confirmed?: number; bullish?: number; bearishFno?: number; excludedCashShorts?: number;
    retainedSignals?: number; radarAsOf?: string | number | null };
  dataQuality?: { latestCandleAt?: string | null; stale?: boolean; skippedSymbolCount?: number; pendingSignalWrites?: number };
};
type DisplayRow = { candidate: Candidate; signal?: Signal; priority?: Priority; rank?: number; key: string };
const CACHE_KEY = "alpha-radar:intraday-breakouts:v6";
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const typeFor = (direction: Candidate["direction"], basis: Basis): SignalType => direction === "SHORT"
  ? (basis === "FIVE" ? "FIVE_MIN_BREAKDOWN" : basis === "FIFTEEN" ? "FIFTEEN_MIN_BREAKDOWN" : "PREVIOUS_DAY_LOW_BREAK")
  : (basis === "FIVE" ? "FIVE_MIN_BREAKOUT" : basis === "FIFTEEN" ? "FIFTEEN_MIN_BREAKOUT" : "PREVIOUS_DAY_HIGH_BREAK");

export default function IntradayBreakoutsContent() {
  const [data, setData] = useState<IntradayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [now, setNow] = useState(0);
  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const response = await fetchAPI<IntradayResponse>("/api/intraday/breakouts");
      setData(response); setVerified(true); setError(null); setNow(Date.now());
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(response)); } catch { /* Storage is optional. */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The intraday feed is unavailable."); setVerified(false);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as IntradayResponse;
        if (Array.isArray(parsed.candidates) && parsed.summary) setData(parsed);
      }
    } catch { /* Ignore damaged or unavailable browser storage. */ }
    void load(true);
    const poll = window.setInterval(() => {
      // Rediscover the next session even when the page stays open overnight.
      if (document.visibilityState === "visible") void load(true);
    }, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 15_000);
    const resume = () => { if (document.visibilityState === "visible") void load(true); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("focus", resume);
    return () => {
      clearInterval(poll); clearInterval(clock);
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume);
    };
  }, [load]);
  return <IntradayBreakoutsView data={data} loading={loading} error={error} verified={verified} now={now} onRefresh={() => void load()} />;
}

export function IntradayBreakoutsView({ data, loading, error, verified, now, onRefresh }: {
  data: IntradayResponse | null; loading: boolean; error: string | null; verified: boolean; now: number; onRefresh: () => void;
}) {
  const [basis, setBasis] = useState<Basis>("FIVE");
  const [direction, setDirection] = useState<Direction>("ALL");
  const [view, setView] = useState<"PRIORITY" | "HISTORY">("PRIORITY");
  const [sort, setSort] = useState<Sort>({ key: null, direction: "asc" });
  const generated = data?.generatedAt ? new Date(data.generatedAt).getTime() : 0;
  const stale = !verified || Boolean(error || data?.stale || data?.dataQuality?.stale || data?.status === "DEGRADED")
    || Boolean(data?.marketHours && (!generated || now - generated > 90_000));
  const rows = useMemo<DisplayRow[]>(() => {
    const source = (data?.candidates ?? []).filter((row) => direction === "ALL" || row.direction === direction);
    if (view === "PRIORITY") {
      const context = { now, stale, marketOpen: Boolean(data?.marketHours) };
      const ranked = source.map(candidate => {
        const signal = candidate.signals.find(s => s.type === typeFor(candidate.direction, basis));
        return { candidate, signal, priority: priorityFor(candidate, signal, context), key: `${candidate.symbol}-${candidate.direction}` };
      }).sort((a, b) => comparePriority(a.priority, b.priority, a.key, b.key));
      let rank = 0;
      return ranked.map(row => ({ ...row, rank: row.priority.group < 2 ? ++rank : undefined }));
    }
    const events = source.flatMap(candidate => (candidate.events ?? candidate.signals)
      .filter(signal => signal.type === typeFor(candidate.direction, basis))
      .map(signal => ({ candidate, signal, key: signal.eventId || `${candidate.symbol}-${signal.type}-${signal.signalTime}` })));
    return events.sort((a, b) => {
      const value = (signal?: Signal) => !signal ? null : !sort.key || sort.key === "time" ? new Date(signal.signalTime).getTime()
        : sort.key === "high" ? signal.postConfirmationBestReturnPct : signal.postConfirmationCloseReturnPct;
      const l = value(a.signal); const r = value(b.signal);
      if (l == null && r == null) return 0; if (l == null) return 1; if (r == null) return -1;
      return (l - r) * (sort.key && sort.direction === "asc" ? 1 : -1) || a.key.localeCompare(b.key);
    });
  }, [basis, data, direction, sort, view, now, stale]);
  const sortBy = (key: SortKey) => setSort((current) => current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
  if (loading && !data) return <div role="status" className="rounded-xl bg-card px-6 py-16 text-center shadow-sm"><RefreshCw aria-hidden className="mx-auto mb-3 animate-spin text-accent" />Checking intraday candles…</div>;
  const coverage = data?.coverage;
  const scanAt = coverage?.radarAsOf ? new Date(coverage.radarAsOf).getTime() : 0;
  const scanStale = Boolean(data?.marketHours && (!scanAt || now - scanAt > 180_000));
  return <section className="space-y-4">
    <div className="rounded-xl border border-card-border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><Activity aria-hidden className="text-accent" size={24} />
          <div><h2 className="font-bold">Today&apos;s confirmed moves</h2><p className="mt-1 text-sm text-muted">Bullish breakouts and F&amp;O bearish breakdowns · completed candles</p></div>
        </div>
        <div className="flex items-center gap-3"><span className={cn("text-sm font-semibold", data?.marketHours && !stale ? "text-profit" : "text-muted")}>{data?.marketHours ? stale ? "Feed needs checking" : "Live session" : "Market closed"}</span>
          <button className={cn("workspace-button min-h-11", focus)} onClick={onRefresh} disabled={loading}><RefreshCw aria-hidden size={15} className={loading ? "animate-spin" : ""} />Refresh</button>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5"><Metric label="Scan universe" value={coverage?.requested} /><Metric label="Quotes received" value={coverage?.quoted} /><Metric label="Monitored stocks" value={coverage?.monitored} /><Metric label="Complete candles" value={coverage?.completeCandles} /><Metric label="Confirmed stocks" value={coverage?.confirmed ?? data?.summary.signalCandidates} /></div>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-xs text-muted"><span>{coverage?.universe ?? "Coverage unavailable"} · {coverage?.bullish ?? "—"} bullish · {coverage?.bearishFno ?? "—"} bearish F&amp;O · {coverage?.pendingCandles ?? "—"} awaiting candles</span><span>Radar scan {formatTime(coverage?.radarAsOf)} · Updated {formatTime(data?.generatedAt)}</span></div>
      {(!coverage?.fullScan || scanStale || Boolean(coverage?.missingQuotes) || Boolean(data?.dataQuality?.skippedSymbolCount)) && <p className="mt-3 rounded-lg bg-warning/10 p-3 text-sm text-warning">
        {!coverage?.fullScan ? "Partial coverage: waiting for the full Nifty 500 scan. " : ""}{scanStale ? "Radar context is stale. " : ""}{coverage?.missingQuotes ? `${coverage.missingQuotes} stocks have no quote. ` : ""}{data?.dataQuality?.skippedSymbolCount ? `${data.dataQuality.skippedSymbolCount} stocks could not be evaluated. ` : ""}Coverage counts do not guarantee a current entry opportunity.
      </p>}
      <details className="mt-3 text-sm text-muted"><summary className={cn("w-fit cursor-pointer py-2 font-medium text-accent", focus)}>How coverage and entry checks work</summary>
        <p className="mt-2 max-w-4xl leading-relaxed">Intraday monitors eligible names from the full scan without the former top-80, 30-long or 20-short limits. Neutral names and cash-only shorts are excluded. Previously confirmed names stay monitored. Candle history warms in bounded batches; missing candles block entry checks.</p>
        <p className="mt-2 max-w-4xl leading-relaxed">Radar score ranks a stock&apos;s setup; it is not a win probability. Entry checks are separate: fresh data, complete candles, confirmation within 15 minutes, direction and VWAP agreement, no failed level or stop touch, no more than 0.5R extension, and at least 1.5R remaining to a reference target. These rules are not yet validated against trading outcomes.</p>
        <p className="mt-2 max-w-4xl leading-relaxed">Priority now groups entry-ready setups first, then watch candidates, review-only signals, and invalidated or unavailable data. Within a group: current confirmation agreement, freshness, remaining reward/risk, then Radar score. Ranks apply to the selected direction and basis. New pullbacks or previous-day level recrosses can create later confirmations; Today&apos;s history keeps every event.</p>
      </details>
    </div>
    {error && <div role="alert" className="rounded-lg bg-loss-bg p-4 text-sm text-loss">{error}</div>}
    {stale && data && <div role="status" className="rounded-lg bg-warning/10 p-4 text-sm text-warning">Showing a saved or unverified snapshot. Entry checks are paused until a fresh response arrives.</div>}
    {Boolean(data?.dataQuality?.pendingSignalWrites) && <p role="status" className="rounded-lg bg-warning/10 p-4 text-sm text-warning">Some confirmations are awaiting storage. Automatic save retries are running.</p>}
    <div className="flex flex-wrap items-center justify-between gap-3"><div aria-label="Intraday view" className="inline-flex rounded-lg bg-card p-1">{(["PRIORITY", "HISTORY"] as const).map(item => <button key={item} aria-pressed={view === item} onClick={() => setView(item)} className={cn("min-h-11 rounded-md px-4 text-sm font-semibold", focus, view === item ? "bg-accent-bg text-accent" : "text-muted")}>{item === "PRIORITY" ? "Priority now" : "Today's history"}</button>)}</div><p className="text-xs text-muted">{view === "PRIORITY" ? "Latest setup per stock · ranked by current entry checks" : "Every confirmation · newest first by default"}</p></div>
    <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-card-border p-4"><div><h3 className="font-bold">{view === "PRIORITY" ? "Intraday stocks" : "Confirmation history"} <span className="text-muted">({rows.length})</span></h3><p className="mt-1 text-xs text-muted">Returns start at the confirmation close and exclude the confirmation candle&apos;s high/low. Before costs.</p></div>
        <div className="flex flex-wrap items-center gap-3"><div aria-label="Signal direction" className="inline-flex rounded-lg bg-surface-hover p-1">{(["ALL", "LONG", "SHORT"] as Direction[]).map((item) => <button key={item} aria-pressed={direction === item} onClick={() => setDirection(item)} className={cn("min-h-11 rounded-md px-3 text-sm font-semibold", focus, direction === item ? "bg-card text-accent shadow-sm" : "text-muted")}>{item === "ALL" ? "All" : item === "LONG" ? "Bullish" : "Bearish F&O"}</button>)}</div>
          <label className="flex items-center gap-2 text-sm text-muted">Basis<select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className={cn("min-h-11 rounded-lg border border-card-border bg-page-bg px-3 font-semibold text-text-heading", focus)}><option value="FIVE">5M</option><option value="FIFTEEN">15M</option><option value="PREVIOUS_DAY">PDH / PDL</option></select></label>
        </div>
      </div>
      {rows.length ? <div className="overflow-x-auto" role="region" aria-label="Intraday signals table" tabIndex={0}><table className="w-full min-w-[1040px] text-left text-sm"><thead className="bg-surface-hover/60 text-xs uppercase tracking-wide text-muted"><tr><th scope="col" className="px-4 py-3">Stock / Radar score</th><th scope="col" className="px-3 py-3">PDH / PDL</th><Head label={`${basis === "FIVE" ? "5M" : basis === "FIFTEEN" ? "15M" : "Level"} signal`} sortKey="time" sort={sort} onSort={sortBy} enabled={view === "HISTORY"} /><th scope="col" className="px-3 py-3">Entry check</th><Head label="Best" sortKey="high" sort={sort} onSort={sortBy} enabled={view === "HISTORY"} /><Head label="Close" sortKey="close" sort={sort} onSort={sortBy} enabled={view === "HISTORY"} /><th scope="col" className="px-4 py-3 text-right">View</th></tr></thead>
        <tbody className="divide-y divide-card-border">{rows.map(row => <Row key={row.key} candidate={row.candidate} basis={basis} stale={stale} now={now} marketOpen={Boolean(data?.marketHours)} history={view === "HISTORY"} selectedSignal={row.signal} priority={row.priority} rank={row.rank} />)}</tbody></table></div>
        : <div className="p-10 text-center"><p className="font-semibold">{data?.candidates.length ? "No signals match this direction" : "No confirmed moves yet"}</p><p className="mt-2 text-sm text-muted">{coverage?.pendingCandles ? "Candle coverage is still warming. Check the coverage counts above." : "Eligible stocks remain monitored for completed-candle confirmation."}</p></div>}
    </div>
  </section>;
}

function Row({ candidate, basis, stale, now, marketOpen, history, selectedSignal, priority, rank }: { candidate: Candidate; basis: Basis; stale: boolean; now: number; marketOpen: boolean; history: boolean; selectedSignal?: Signal; priority?: Priority; rank?: number }) {
  const [expanded, setExpanded] = useState(false);
  const bearish = candidate.direction === "SHORT";
  const signal = selectedSignal;
  const previous = [...(candidate.events ?? candidate.signals)].reverse().find((s) => s.type === (bearish ? "PREVIOUS_DAY_LOW_BREAK" : "PREVIOUS_DAY_HIGH_BREAK") && (!history || !signal || Date.parse(s.signalTime) <= Date.parse(signal.signalTime)));
  const assessment = signal?.entryAssessment;
  const assessmentOld = Boolean(assessment && (!Number.isFinite(Date.parse(assessment.asOf)) || Date.parse(assessment.asOf) > now || now - Date.parse(assessment.asOf) > 90_000));
  const status = priority?.status ?? entryStatus(signal, { now, stale, marketOpen });
  const detailId = useId();
  const score = history ? signal?.radarScoreAtDetection : candidate.score;
  const breakdown = history ? signal?.radarBreakdownAtDetection : candidate.scoreBreakdown;
  const reason = status === "DATA_CHECK" && (stale || assessmentOld || !assessment) ? "Refresh needed before evaluating entry." : !signal ? "No confirmation for the selected basis." : status === "EXPIRED" ? "Confirmation is older than 15 minutes." : assessment?.reason ?? "Entry assessment is unavailable.";
  return <Fragment><tr className="align-top hover:bg-hover-bg">
    <td className="px-4 py-4"><div className="flex items-center gap-2"><b className="font-mono text-base">{candidate.symbol}</b><span className={cn("rounded px-2 py-1 text-xs font-bold", bearish ? "bg-loss-bg text-loss" : "bg-profit-bg text-profit")}>{candidate.direction}</span>{candidate.isFno && <span className="text-xs text-accent">F&amp;O</span>}</div><div className="mt-1 flex gap-2 text-xs"><span>{price(candidate.ltp)}</span><span className={tone(candidate.changePct)}>{percent(candidate.changePct)}</span></div>
      <button aria-expanded={expanded} aria-controls={detailId} aria-label={`Radar score ${score ?? "unavailable"} and entry details for ${candidate.symbol} ${candidate.direction}${history ? ` event ${signal?.eventNumber ?? 1}` : ""}`} className={cn("mt-1 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent", focus)} onClick={() => setExpanded(!expanded)}>{history ? "Radar at detection" : "Radar score"} {score ?? "—"}<ChevronDown aria-hidden size={15} className={expanded ? "rotate-180" : ""} /></button>
    </td>
    <td className="px-3 py-4">{previous ? <span className={cn("inline-block rounded-md px-2 py-1 text-xs font-semibold", bearish ? "bg-loss-bg text-loss" : "bg-warning/10 text-warning")}>{bearish ? "PDL" : "PDH"} {formatTime(previous.signalTime)}</span> : <span className="text-muted">—</span>}</td>
    <td className="px-3 py-4"><b>{formatTime(signal?.signalTime)}</b>{signal && <div className="mt-1 text-xs text-muted">Level {price(signal.breakoutLevel)}{(signal.eventNumber ?? 1) > 1 && <span className="mt-1 block text-accent">Setup #{signal.eventNumber}</span>}</div>}</td>
    <td className="max-w-[270px] px-3 py-4">{priority && <p className="mb-2 text-xs font-bold text-muted">{rank != null ? `#${rank} · ` : ""}{priority.groupLabel}</p>}<span className={cn("inline-block rounded-md px-2 py-1 text-xs font-bold", statusTone(status))}>{statusLabel(status)}</span><p className="mt-2 text-xs leading-relaxed text-muted">{reason}</p>{priority && rank != null && <p className="mt-2 text-xs text-accent">{priority.reason}</p>}</td>
    <td className={cn("px-3 py-4 font-mono font-bold", tone(signal?.postConfirmationBestReturnPct))}>{percent(signal?.postConfirmationBestReturnPct)}</td><td className={cn("px-3 py-4 font-mono font-bold", tone(signal?.postConfirmationCloseReturnPct))}>{percent(signal?.postConfirmationCloseReturnPct)}</td>
    <td className="px-4 py-4"><div className="flex justify-end gap-2"><Link aria-label={`Chart for ${candidate.symbol}`} href={`/pulse/intraday/${encodeURIComponent(candidate.symbol)}`} className={cn("workspace-button min-h-11", focus)}>Chart<ArrowUpRight aria-hidden size={14} /></Link>{candidate.isFno && <Link aria-label={`Options for ${candidate.symbol}`} href={`/radar-trade?symbol=${encodeURIComponent(candidate.symbol)}&view=options&from=intraday`} className={cn("workspace-button min-h-11", focus)}>F&amp;O</Link>}</div></td>
  </tr><tr id={detailId} hidden={!expanded}><td colSpan={7} className="bg-surface-hover/30 p-4 sm:p-6"><div className="grid gap-6 lg:grid-cols-2">
    <div><h4 className="font-bold">Radar score explained</h4><p className="mt-1 text-xs text-muted">{history ? `Score context saved at detection · ${formatTime(signal?.detectedAt)}` : `Current Radar direction: ${candidate.radarBias ?? "unavailable"} · Scan ${formatTime(candidate.radarAsOf)}`}</p>
      {breakdown ? <ScoreBreakdown breakdown={breakdown} /> : <p className="mt-3 text-sm text-muted">Exact components were not saved for this scan or event.</p>}
      {signal?.radarScoreAtDetection != null && <p className="mt-3 text-sm">Radar score when detected: <b>{signal.radarScoreAtDetection}</b> · {formatTime(signal.detectedAt)}<span className="mt-1 block text-xs text-muted">Detection can happen after candle confirmation during backfill; this is not a historical score at the signal time.</span></p>}
    </div>
    <div><h4 className="font-bold">Entry assessment · {basis === "PREVIOUS_DAY" ? "PDH / PDL" : basis === "FIVE" ? "5M" : "15M"}</h4>
      {assessment ? <><p className="mt-2 text-sm">{reason}</p><div className="mt-3 grid grid-cols-3 gap-3"><SmallMetric label="Quote / entry reference" value={price(assessment.entry)} /><SmallMetric label="Structural stop" value={price(assessment.stop)} /><SmallMetric label="Reference target" value={price(assessment.referenceTarget)} /><SmallMetric label="Remaining reward/risk" value={assessment.remainingRewardRisk == null ? "—" : `${assessment.remainingRewardRisk.toFixed(2)}R`} /><SmallMetric label="Distance from confirmation" value={assessment.entryDistanceR == null ? "—" : `${assessment.entryDistanceR.toFixed(2)}R`} /><SmallMetric label="Signal age at check" value={assessment.signalAgeMinutes == null ? "—" : `${assessment.signalAgeMinutes.toFixed(1)} min`} /></div>
        <p className="mt-3 text-xs leading-relaxed text-muted">{assessment.targetBasis} Checks at {formatTime(assessment.asOf)}; quote at {formatTime(assessment.quoteAsOf)}. Levels exclude fees and slippage.</p><ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">{assessment.checks.map((check) => <li key={check.label} className={check.passed && !stale && !assessmentOld ? "text-profit" : "text-muted"}>{stale || assessmentOld ? "Unchecked" : check.passed ? "Pass" : "Wait"} · {check.label}</li>)}</ul></> : <p className="mt-3 text-sm text-muted">{reason}</p>}
    </div>
  </div></td></tr></Fragment>;
}

function ScoreBreakdown({ breakdown }: { breakdown: Breakdown }) {
  return <><dl className="mt-3 space-y-2 text-sm">{breakdown.components.map((part) => <div key={part.label} className="flex justify-between gap-4"><dt className="text-muted">{part.label}</dt><dd className="font-mono">{part.points > 0 ? "+" : ""}{part.points.toFixed(2)}</dd></div>)}<div className="flex justify-between border-t border-card-border pt-2 font-bold"><dt>Radar score</dt><dd>{breakdown.total} / 100</dd></div></dl><p className="mt-3 text-xs text-muted">Move {percent(breakdown.inputs.changePct)} · Volume {breakdown.inputs.volRatio.toFixed(2)}× · Range {breakdown.inputs.rFactor.toFixed(2)}×</p><div className="mt-2 flex flex-wrap gap-2">{breakdown.setups.map((setup) => <span key={setup} className="rounded bg-accent-bg px-2 py-1 text-xs text-accent">{setup.replaceAll("_", " ")}</span>)}</div><p className="mt-3 text-xs leading-relaxed text-muted">{breakdown.note}</p></>;
}
function Metric({ label, value }: { label: string; value?: number | null }) { return <div className="rounded-lg bg-surface-hover/60 p-3"><div className="text-2xl font-bold tabular-nums">{value ?? "—"}</div><div className="mt-1 text-xs text-muted">{label}</div></div>; }
function SmallMetric({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted">{label}</p><p className="mt-1 font-mono text-sm font-bold">{value}</p></div>; }
function Head({ label, sortKey, sort, onSort, enabled }: { label: string; sortKey: SortKey; sort: Sort; onSort: (key: SortKey) => void; enabled: boolean }) { if (!enabled) return <th scope="col" className="px-3 py-3">{label}</th>; return <th scope="col" aria-sort={sort.key === sortKey ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="px-3 py-1"><button className={cn("inline-flex min-h-11 items-center gap-1", focus)} onClick={() => onSort(sortKey)}>{label}<ArrowUpDown aria-hidden size={12} className={sort.key === sortKey ? "text-accent" : ""} /></button></th>; }
function statusLabel(status: string) { return ({ CHECKS_PASSED: "Checks passed", DATA_CHECK: "Check data", INVALIDATED: "Invalidated", EXPIRED: "Expired", EXTENDED: "Extended", WAIT: "Wait", MARKET_CLOSED: "Session closed", TARGET_REACHED: "Target reached", NO_CONFIRMATION: "Awaiting confirmation", SUPERSEDED: "Earlier setup" } as Record<string, string>)[status] ?? "Check data"; }
function statusTone(status: string) { return status === "CHECKS_PASSED" ? "bg-profit-bg text-profit" : status === "INVALIDATED" ? "bg-loss-bg text-loss" : ["EXPIRED", "EXTENDED", "DATA_CHECK"].includes(status) ? "bg-warning/10 text-warning" : "bg-surface-hover text-muted"; }
function formatTime(value?: string | number | null) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).format(date) : "—"; }
function price(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function percent(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`; }
function tone(value?: number | null) { return value == null ? "text-muted" : value >= 0 ? "text-profit" : "text-loss"; }
