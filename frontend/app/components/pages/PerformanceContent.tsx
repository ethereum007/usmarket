"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAPI, postAPI } from "../../lib/api";
import { cn } from "../../lib/utils";

type Horizon = "15m" | "1h" | "eod" | "next_day_eod";
const OUTCOME_HORIZONS: Horizon[] = ["15m", "1h", "eod", "next_day_eod"];

interface EdgeVerdict {
  label: "SIZE_UP" | "TRADE_SMALL" | "WATCH" | "PAUSE" | "NEEDS_SAMPLE" | string;
  action: string;
  score: number | null;
  sample: string;
  reason: string;
}

interface HorizonStats {
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
  top_signal?: string | null;
  edge?: EdgeVerdict;
}

interface FamilyStats {
  label: string;
  order: number;
  signal_count: number;
  signal_types: string[];
  horizons: Partial<Record<Horizon, HorizonStats>>;
}

interface OutcomeHealth {
  status: "clear" | "waiting" | "due" | "blocked" | string;
  pending: number;
  due: number;
  overdue: number;
  kite_required: boolean;
  by_horizon: Partial<Record<Horizon, {
    pending: number;
    due: number;
    overdue: number;
    next_due_at?: string | null;
    oldest_due_at?: string | null;
  }>>;
}

interface StatsResponse {
  success: boolean;
  as_of: string;
  days: number;
  by_signal_type: Record<string, Partial<Record<Horizon, HorizonStats>>>;
  by_family?: Record<string, FamilyStats>;
  outcome_health?: OutcomeHealth;
}

interface SignalOutcomeRow {
  horizon?: Horizon | string;
  status?: string;
  return_pct?: number | null;
  mfe_pct?: number | null;
  mae_pct?: number | null;
}

interface SignalFireRow {
  id?: string;
  signal_type?: string;
  symbol?: string;
  category?: string;
  fired_at?: string;
  trigger_price?: number | null;
  strength?: number | null;
  direction?: "BULLISH" | "BEARISH" | string;
  confidence?: string | null;
  metadata?: Record<string, unknown> | null;
  signal_outcomes?: SignalOutcomeRow[];
}

interface FireRoleSummary {
  fires: number;
  resolved: number;
  wins: number;
  losses: number;
  flats: number;
  win_rate: number | null;
}

interface FireSummary {
  total: number;
  discovery: number;
  trade_signals: number;
  early_entry_zone: number;
  wait_for_pullback: number;
  by_role: Record<string, FireRoleSummary>;
  by_readiness: Record<string, number>;
  by_strategy: Record<string, number>;
}

interface FiresResponse {
  success: boolean;
  count: number;
  fires: SignalFireRow[];
  summary?: FireSummary;
}

interface OutcomeCheckResponse {
  success: boolean;
  horizon: Horizon;
  checked: number;
  updated: number;
  skipped: number;
  errors: number;
}

interface ScorecardRow {
  signalType: string;
  horizons: Partial<Record<Horizon, HorizonStats>>;
  total: number;
  resolved: number;
  winRate: number | null;
  avgReturn: number | null;
  avgMfe: number | null;
  avgMae: number | null;
}

interface EngineFamilyRow {
  key: string;
  label: string;
  signalCount: number;
  total: number;
  resolved: number;
  pending: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgReturn: number | null;
  avgMfe: number | null;
  avgMae: number | null;
  topSignal: string;
  edge?: EdgeVerdict;
}

export default function PerformanceContent() {
  const [days, setDays] = useState(15);
  const [data, setData] = useState<StatsResponse | null>(null);
  const [fires, setFires] = useState<SignalFireRow[]>([]);
  const [fireSummary, setFireSummary] = useState<FireSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [firesError, setFiresError] = useState<string | null>(null);
  const [checkingHorizon, setCheckingHorizon] = useState<Horizon | null>(null);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFiresError(null);
    try {
      const [statsResult, firesResult] = await Promise.allSettled([
        fetchAPI<StatsResponse>(`/api/performance/signal-stats?days=${days}`),
        fetchAPI<FiresResponse>(`/api/performance/signal-fires?days=${days}&limit=80`),
      ]);

      if (statsResult.status === "fulfilled") {
        setData(statsResult.value);
      } else {
        throw statsResult.reason;
      }

      if (firesResult.status === "fulfilled") {
        setFires(Array.isArray(firesResult.value.fires) ? firesResult.value.fires : []);
        setFireSummary(firesResult.value.summary || null);
      } else {
        setFires([]);
        setFireSummary(null);
        setFiresError(firesResult.reason instanceof Error ? firesResult.reason.message : "Could not load recent signal fires.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load performance data.");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const runOutcomeCheck = useCallback(async (horizon: Horizon) => {
    setCheckingHorizon(horizon);
    setCheckResult(null);
    setCheckError(null);
    try {
      const result = await postAPI<OutcomeCheckResponse>(`/api/performance/run-outcome-check?horizon=${encodeURIComponent(horizon)}`, {});
      setCheckResult(`${result.horizon}: ${result.updated}/${result.checked} updated, ${result.skipped} skipped, ${result.errors} errors`);
      await load();
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Could not run outcome check.");
    } finally {
      setCheckingHorizon(null);
    }
  }, [load]);

  const rows = useMemo<ScorecardRow[]>(() => {
    if (!data) return [];
    return Object.entries(data.by_signal_type)
      .map(([signalType, horizons]) => {
        const h1 = horizons["1h"];
        const eod = horizons.eod;
        const total = h1?.total ?? eod?.total ?? 0;
        const resolved = h1?.resolved ?? eod?.resolved ?? 0;
        const winRate = h1?.win_rate ?? eod?.win_rate ?? null;
        const avgReturn = h1?.avg_return_pct ?? eod?.avg_return_pct ?? null;
        const avgMfe = h1?.avg_mfe_pct ?? eod?.avg_mfe_pct ?? null;
        const avgMae = h1?.avg_mae_pct ?? eod?.avg_mae_pct ?? null;
        return { signalType, horizons, total, resolved, winRate, avgReturn, avgMfe, avgMae };
      })
      .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.resolved - a.resolved);
  }, [data]);

  const engineFamilies = useMemo(() => buildEngineFamiliesFromApi(data?.by_family) ?? buildEngineFamilies(rows), [data?.by_family, rows]);

  const totals = useMemo(() => {
    let total = 0;
    let resolved = 0;
    let wins = 0;
    let losses = 0;
    rows.forEach((row) => {
      const h1 = row.horizons["1h"];
      if (!h1) return;
      total += h1.total;
      resolved += h1.resolved;
      wins += h1.wins;
      losses += h1.losses;
    });
    return {
      total,
      resolved,
      wins,
      losses,
      winRate: resolved > 0 ? Math.round((wins / resolved) * 1000) / 10 : null,
    };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="bg-card border border-card-border rounded-lg p-4">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">Signal Performance</div>
            <h2 className="text-lg font-semibold text-text-heading mt-1">Measure the signal, then judge the edge</h2>
            <p className="text-xs text-muted mt-1 max-w-3xl">
              Shadow-mode hit-rate by signal type and horizon. This is the scorecard for whether Radar, swing, and scanner logic deserve more size.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select aria-label="Performance window"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="bg-page-bg border border-card-border rounded px-3 py-2 text-xs text-foreground"
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={15}>15 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="px-3 py-2 rounded border border-card-border text-xs text-foreground hover:bg-hover-bg disabled:opacity-50"
            >
              {loading ? "Loading" : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {error && <div className="bg-loss-bg border border-loss/20 rounded p-3 text-loss text-sm">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Summary label="1H Fires" value={totals.total} />
        <Summary label="Resolved" value={totals.resolved} />
        <Summary label="Win Rate" value={totals.winRate == null ? "-" : `${totals.winRate}%`} tone={totals.winRate != null && totals.winRate >= 55 ? "profit" : "warning"} />
        <Summary label="W/L" value={`${totals.wins}/${totals.losses}`} />
      </div>

      {fireSummary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Summary label="Discovery Fires" value={fireSummary.discovery} />
          <Summary label="Early Entry" value={fireSummary.early_entry_zone} tone="profit" />
          <Summary label="Pullback Wait" value={fireSummary.wait_for_pullback} tone="warning" />
          <Summary
            label="Discovery Win"
            value={fireSummary.by_role.DISCOVERY?.win_rate == null ? "-" : `${fireSummary.by_role.DISCOVERY.win_rate}%`}
            tone={(fireSummary.by_role.DISCOVERY?.win_rate || 0) >= 55 ? "profit" : "warning"}
          />
        </div>
      )}

      {data?.outcome_health && (
        <OutcomeHealthPanel
          health={data.outcome_health}
          checkingHorizon={checkingHorizon}
          checkResult={checkResult}
          checkError={checkError}
          onRunCheck={runOutcomeCheck}
        />
      )}

      {engineFamilies.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {engineFamilies.map((family) => (
            <EngineFamilyCard key={family.key} family={family} />
          ))}
        </div>
      )}

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text-heading">Engine Scorecard</div>
            <div className="text-xs text-muted">
              {data ? `As of ${new Date(data.as_of).toLocaleString("en-IN")}` : "Waiting for stats"}
            </div>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-card-border text-muted">
                <th className="text-left px-4 py-2">Signal Type</th>
                <th className="text-right px-2 py-2">1H N</th>
                <th className="text-right px-2 py-2">1H Win</th>
                <th className="text-right px-2 py-2">1H Avg</th>
                <th className="text-right px-2 py-2">EOD Win</th>
                <th className="text-right px-2 py-2">MFE</th>
                <th className="text-right px-4 py-2">MAE</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((row) => (
                <tr key={row.signalType} className="border-b border-card-border/30 hover:bg-hover-bg">
                  <td className="px-4 py-2 font-semibold text-foreground">{row.signalType}</td>
                  <td className="text-right px-2 py-2">{row.horizons["1h"] ? `${row.horizons["1h"]!.resolved}/${row.horizons["1h"]!.total}` : "-"}</td>
                  <td className={cn("text-right px-2 py-2 font-bold", rateTone(row.horizons["1h"]?.win_rate))}>{fmtPct(row.horizons["1h"]?.win_rate)}</td>
                  <td className={cn("text-right px-2 py-2", returnTone(row.horizons["1h"]?.avg_return_pct))}>{fmtSigned(row.horizons["1h"]?.avg_return_pct)}</td>
                  <td className={cn("text-right px-2 py-2 font-bold", rateTone(row.horizons.eod?.win_rate))}>{fmtPct(row.horizons.eod?.win_rate)}</td>
                  <td className="text-right px-2 py-2 text-profit">{fmtSigned(row.avgMfe)}</td>
                  <td className="text-right px-4 py-2 text-loss">{fmtSigned(row.avgMae)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-muted">
                    No tracked signal outcomes yet. The validator will populate this as market signals fire and mature.
                  </td>
                </tr>
              )}
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-muted">Loading performance scorecard...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text-heading">Recent Signal Fires</div>
            <div className="text-xs text-muted">
              Raw validator log for spot-checking what the scorecard is learning from.
            </div>
          </div>
          <span className="text-xs text-muted">{fires.length} fires</span>
        </div>
        {firesError && <div className="m-3 bg-warning/10 border border-warning/20 rounded p-3 text-warning text-sm">{firesError}</div>}
        <div className="overflow-auto max-h-[420px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-card-border text-muted">
                <th className="text-left px-4 py-2">Time</th>
                <th className="text-left px-2 py-2">Symbol</th>
                <th className="text-left px-2 py-2">Type</th>
                <th className="text-left px-2 py-2">Role</th>
                <th className="text-left px-2 py-2">Dir</th>
                <th className="text-right px-2 py-2">Strength</th>
                <th className="text-right px-2 py-2">Trigger</th>
                <th className="text-left px-4 py-2">Outcomes</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {fires.map((fire) => (
                <tr key={fire.id || `${fire.symbol}-${fire.signal_type}-${fire.fired_at}`} className="border-b border-card-border/30 hover:bg-hover-bg">
                  <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(fire.fired_at)}</td>
                  <td className="px-2 py-2 font-semibold text-foreground">{fire.symbol || "-"}</td>
                  <td className="px-2 py-2">{fire.signal_type || "-"}</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-1">
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold", roleClass(fireRole(fire)))}>
                        {fireRole(fire)}
                      </span>
                      {fireReadiness(fire) !== "TRADE_READY" && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-warning/10 text-warning">
                          {readinessLabel(fireReadiness(fire))}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={cn("px-2 py-2 font-semibold", fire.direction === "BULLISH" ? "text-profit" : fire.direction === "BEARISH" ? "text-loss" : "text-muted")}>
                    {fire.direction || "-"}
                  </td>
                  <td className="text-right px-2 py-2">{formatMetric(fire.strength)}</td>
                  <td className="text-right px-2 py-2">{formatMetric(fire.trigger_price)}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {outcomePills(fire.signal_outcomes).map((item) => (
                        <span key={item.key} className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", outcomeClass(item.status))}>
                          {item.label}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && fires.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted">
                    No recent fires in this window yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function OutcomeHealthPanel({
  health,
  checkingHorizon,
  checkResult,
  checkError,
  onRunCheck,
}: {
  health: OutcomeHealth;
  checkingHorizon: Horizon | null;
  checkResult: string | null;
  checkError: string | null;
  onRunCheck: (horizon: Horizon) => void;
}) {
  const dueHorizons = OUTCOME_HORIZONS.filter((horizon) => {
    const row = health.by_horizon[horizon];
    return row && (row.due > 0 || row.overdue > 0);
  });

  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted">Outcome Validator</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold", healthClass(health.status))}>
              {health.status.toUpperCase()}
            </span>
            <span className="text-sm text-text-heading font-semibold">
              {health.overdue > 0
                ? `${health.overdue} overdue outcomes need resolution`
                : health.due > 0
                  ? `${health.due} outcomes are ready to check`
                  : health.pending > 0
                    ? `${health.pending} outcomes are waiting to mature`
                    : "No pending validation backlog"}
            </span>
          </div>
          {health.kite_required && (
            <div className="text-xs text-muted mt-1">
              Kite must be connected for the backend validator to resolve due outcomes.
            </div>
          )}
          {checkResult && <div className="text-xs text-profit mt-2">{checkResult}</div>}
          {checkError && <div className="text-xs text-loss mt-2">{checkError}</div>}
        </div>
        <div className="flex flex-col gap-2 min-w-[260px]">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <MiniStat label="Pending" value={`${health.pending}`} />
            <MiniStat label="Due" value={`${health.due}`} tone={health.due > 0 ? "text-warning" : undefined} />
            <MiniStat label="Overdue" value={`${health.overdue}`} tone={health.overdue > 0 ? "text-loss" : undefined} />
          </div>
          {dueHorizons.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {dueHorizons.map((horizon) => (
                <button
                  key={horizon}
                  type="button"
                  onClick={() => onRunCheck(horizon)}
                  disabled={checkingHorizon != null}
                  className="px-2.5 py-1 rounded border border-card-border text-[11px] font-semibold text-foreground hover:bg-hover-bg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {checkingHorizon === horizon ? "Running" : `Run ${horizon}`}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: number | string; tone?: "profit" | "warning" }) {
  return (
    <div className="bg-card border border-card-border rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("text-2xl font-bold mt-1", tone === "profit" && "text-profit", tone === "warning" && "text-warning")}>{value}</div>
    </div>
  );
}

function EngineFamilyCard({ family }: { family: EngineFamilyRow }) {
  const verdict = family.edge || buildLocalEdgeVerdict(family);
  const winTone = family.winRate != null && family.winRate >= 55 ? "profit" : family.winRate != null && family.winRate < 45 ? "loss" : "warning";
  return (
    <div className="bg-card border border-card-border rounded p-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-text-heading truncate">{family.label}</div>
        <span className={cn("text-xs font-bold tabular-nums", toneText(winTone))}>
          {family.winRate == null ? "-" : `${family.winRate}%`}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold", edgeClass(verdict.label))}>
          {edgeLabel(verdict.label)}
        </span>
        <span className="text-[11px] text-muted truncate" title={verdict.reason}>{verdict.action}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <MiniStat label="N" value={`${family.resolved}/${family.total}`} />
        <MiniStat label="W/L" value={`${family.wins}/${family.losses}`} />
        <MiniStat label="Avg" value={fmtSigned(family.avgReturn)} tone={returnTone(family.avgReturn)} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="truncate" title={family.topSignal}>{family.topSignal}</span>
        <span>{family.signalCount} types</span>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted">{label}</div>
      <div className={cn("font-mono font-semibold truncate", tone || "text-foreground")} title={value}>{value}</div>
    </div>
  );
}

function buildEngineFamiliesFromApi(families?: Record<string, FamilyStats>): EngineFamilyRow[] | null {
  if (!families || Object.keys(families).length === 0) return null;

  const rows: EngineFamilyRow[] = [];
  for (const [key, family] of Object.entries(families)) {
    const h = family.horizons["1h"] || family.horizons.eod;
    if (!h) continue;
    rows.push({
      key,
      label: family.label,
      signalCount: family.signal_count,
      total: h.total,
      resolved: h.resolved,
      pending: h.pending,
      wins: h.wins,
      losses: h.losses,
      winRate: h.win_rate,
      avgReturn: h.avg_return_pct,
      avgMfe: h.avg_mfe_pct,
      avgMae: h.avg_mae_pct,
      topSignal: h.top_signal || family.signal_types[0] || "-",
      edge: h.edge,
    });
  }
  return rows.sort((a, b) => signalFamilyOrder(a.key) - signalFamilyOrder(b.key));
}

function buildEngineFamilies(rows: ScorecardRow[]): EngineFamilyRow[] {
  const groups = new Map<string, {
    label: string;
    order: number;
    signalTypes: Set<string>;
    total: number;
    resolved: number;
    pending: number;
    wins: number;
    losses: number;
    sumReturn: number;
    sumMfe: number;
    sumMae: number;
    topSignal: string;
    topResolved: number;
  }>();

  for (const row of rows) {
    const family = signalFamily(row.signalType);
    const bucket = groups.get(family.key) || {
      label: family.label,
      order: family.order,
      signalTypes: new Set<string>(),
      total: 0,
      resolved: 0,
      pending: 0,
      wins: 0,
      losses: 0,
      sumReturn: 0,
      sumMfe: 0,
      sumMae: 0,
      topSignal: row.signalType,
      topResolved: 0,
    };
    const h = row.horizons["1h"] || row.horizons.eod;
    if (!h) continue;

    bucket.signalTypes.add(row.signalType);
    bucket.total += h.total;
    bucket.resolved += h.resolved;
    bucket.pending += h.pending;
    bucket.wins += h.wins;
    bucket.losses += h.losses;
    if (h.resolved > 0) {
      bucket.sumReturn += (h.avg_return_pct ?? 0) * h.resolved;
      bucket.sumMfe += (h.avg_mfe_pct ?? 0) * h.resolved;
      bucket.sumMae += (h.avg_mae_pct ?? 0) * h.resolved;
    }
    if (h.resolved > bucket.topResolved) {
      bucket.topSignal = row.signalType;
      bucket.topResolved = h.resolved;
    }
    groups.set(family.key, bucket);
  }

  return Array.from(groups.entries())
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      signalCount: bucket.signalTypes.size,
      total: bucket.total,
      resolved: bucket.resolved,
      pending: bucket.pending,
      wins: bucket.wins,
      losses: bucket.losses,
      winRate: bucket.resolved > 0 ? Math.round((bucket.wins / bucket.resolved) * 1000) / 10 : null,
      avgReturn: bucket.resolved > 0 ? Math.round((bucket.sumReturn / bucket.resolved) * 100) / 100 : null,
      avgMfe: bucket.resolved > 0 ? Math.round((bucket.sumMfe / bucket.resolved) * 100) / 100 : null,
      avgMae: bucket.resolved > 0 ? Math.round((bucket.sumMae / bucket.resolved) * 100) / 100 : null,
      topSignal: bucket.topSignal,
      edge: undefined,
    }))
    .sort((a, b) => signalFamilyOrder(a.key) - signalFamilyOrder(b.key));
}

function buildLocalEdgeVerdict(family: EngineFamilyRow): EdgeVerdict {
  if (family.resolved < 5) {
    return {
      label: "NEEDS_SAMPLE",
      action: "Keep shadow-mode",
      score: null,
      sample: "thin",
      reason: `Only ${family.resolved} resolved outcomes.`,
    };
  }
  if ((family.winRate ?? 0) >= 60 && (family.avgReturn ?? 0) > 0 && family.resolved >= 10) {
    return { label: "SIZE_UP", action: "Trust with defined risk", score: 75, sample: "usable", reason: "Win rate and average return are positive." };
  }
  if ((family.winRate ?? 0) >= 50 && (family.avgReturn ?? 0) >= 0) {
    return { label: "TRADE_SMALL", action: "Use smaller size", score: 60, sample: "early", reason: "Performance is positive but not fully proven." };
  }
  if ((family.winRate ?? 0) < 40 || (family.avgReturn ?? 0) < -0.2) {
    return { label: "PAUSE", action: "Do not size this engine", score: 35, sample: "usable", reason: "Resolved outcomes are weak." };
  }
  return { label: "WATCH", action: "Wait for more proof", score: 50, sample: "early", reason: "Outcome profile is mixed." };
}

function edgeLabel(label: string) {
  if (label === "SIZE_UP") return "SIZE";
  if (label === "TRADE_SMALL") return "SMALL";
  if (label === "NEEDS_SAMPLE") return "SAMPLE";
  return label;
}

function edgeClass(label: string) {
  if (label === "SIZE_UP") return "bg-profit-bg text-profit";
  if (label === "TRADE_SMALL") return "bg-accent-bg text-accent";
  if (label === "WATCH" || label === "NEEDS_SAMPLE") return "bg-[rgba(255,193,7,0.1)] text-warning";
  if (label === "PAUSE") return "bg-loss-bg text-loss";
  return "bg-surface-hover text-muted";
}

function healthClass(status: string) {
  if (status === "blocked") return "bg-loss-bg text-loss";
  if (status === "due" || status === "waiting") return "bg-[rgba(255,193,7,0.1)] text-warning";
  return "bg-profit-bg text-profit";
}

function signalFamily(signalType: string) {
  if (signalType.startsWith("SWING_")) return { key: "swing", label: "Swing", order: 2 };
  if (signalType.startsWith("ABNORMAL_")) return { key: "abnormal", label: "Abnormal", order: 3 };
  if (signalType.startsWith("OI_")) return { key: "options", label: "Options OI", order: 4 };
  if (signalType === "52W_BOUNCE" || signalType.startsWith("ACCUM_")) return { key: "positional", label: "Positional", order: 5 };
  if (
    signalType.startsWith("INTRADAY_RADAR_") ||
    signalType.startsWith("PULSE_") ||
    signalType.startsWith("PDH_") ||
    signalType.startsWith("PDL_") ||
    signalType.startsWith("COMBO_") ||
    signalType.startsWith("ORB_") ||
    signalType.startsWith("BUYING_SCORE") ||
    signalType.startsWith("BEAR_SCORE")
  ) {
    return { key: "intraday", label: "Intraday", order: 1 };
  }
  return { key: "other", label: "Other", order: 99 };
}

function signalFamilyOrder(key: string) {
  return { intraday: 1, swing: 2, abnormal: 3, options: 4, positional: 5, other: 99 }[key as "intraday" | "swing" | "abnormal" | "options" | "positional" | "other"] ?? 99;
}

function fmtPct(value?: number | null) {
  return value == null ? "-" : `${value}%`;
}

function fmtSigned(value?: number | null) {
  if (value == null) return "-";
  return `${value > 0 ? "+" : ""}${value}%`;
}

function rateTone(value?: number | null) {
  if (value == null) return "text-muted";
  if (value >= 60) return "text-profit";
  if (value >= 45) return "text-warning";
  return "text-loss";
}

function returnTone(value?: number | null) {
  if (value == null) return "text-muted";
  if (value > 0) return "text-profit";
  if (value < 0) return "text-loss";
  return "text-muted";
}

function toneText(tone: "profit" | "warning" | "loss") {
  if (tone === "profit") return "text-profit";
  if (tone === "warning") return "text-warning";
  return "text-loss";
}

function formatDateTime(value?: string) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return value;
  }
}

function formatMetric(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return Number(value.toFixed(2)).toString();
}

function fireRole(fire: SignalFireRow) {
  const role = typeof fire.metadata?.tracking_role === "string" ? fire.metadata.tracking_role : "TRADE_SIGNAL";
  return role.toUpperCase();
}

function fireReadiness(fire: SignalFireRow) {
  const readiness = typeof fire.metadata?.trade_readiness === "string" ? fire.metadata.trade_readiness : "TRADE_READY";
  return readiness.toUpperCase();
}

function roleClass(role: string) {
  if (role === "DISCOVERY") return "bg-accent-bg text-accent";
  return "bg-profit-bg text-profit";
}

function readinessLabel(readiness: string) {
  if (readiness === "EARLY_ENTRY_ZONE") return "EARLY";
  if (readiness === "WAIT_FOR_PULLBACK") return "WAIT";
  return readiness.replaceAll("_", " ");
}

function outcomePills(outcomes?: SignalOutcomeRow[]) {
  const rows = outcomes || [];
  if (!rows.length) return [{ key: "none", status: "PENDING", label: "pending" }];
  return rows
    .slice()
    .sort((a, b) => horizonRank(a.horizon) - horizonRank(b.horizon))
    .map((outcome, index) => ({
      key: `${outcome.horizon || index}-${outcome.status || "PENDING"}`,
      status: outcome.status || "PENDING",
      label: `${outcome.horizon || "?"}:${outcome.status || "PENDING"}${outcome.return_pct == null ? "" : ` ${fmtSigned(outcome.return_pct)}`}`,
    }));
}

function horizonRank(horizon?: string) {
  const order: Record<string, number> = { "15m": 1, "1h": 2, eod: 3, next_day_eod: 4 };
  return order[horizon || ""] || 99;
}

function outcomeClass(status?: string) {
  if (status === "WIN") return "bg-profit-bg text-profit";
  if (status === "LOSS") return "bg-loss-bg text-loss";
  if (status === "FLAT") return "bg-[rgba(255,193,7,0.1)] text-warning";
  return "bg-surface-hover text-muted";
}
