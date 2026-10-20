"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchAlerts, fetchDates, fetchTails } from "../lib/fetchers";
import {
  BENCHMARKS,
  PRIMARY_BENCHMARK,
  SECTOR_GROUPS,
  TIMEFRAMES,
  type Benchmark,
  type SectorGroup,
  type Timeframe,
} from "../lib/universe";
import type { AlertRow, RrgRow } from "../lib/types";

import { AlertsPanel } from "./AlertsPanel";
import { DateSlider } from "./DateSlider";
import { HowToRead } from "./HowToRead";
import { QuadrantSummary } from "./QuadrantSummary";
import { RRGChart } from "./RRGChart";
import { SectorTable } from "./SectorTable";
import { TodaysPlaybook } from "./TodaysPlaybook";
import { Toggle } from "./Toggle";

const TAIL_OPTIONS = [
  { value: "3", label: "3" },
  { value: "5", label: "5" },
  { value: "10", label: "10" },
  { value: "20", label: "20" },
] as const;

const BENCHMARK_OPTIONS = BENCHMARKS.map((b) => ({
  value: b,
  label: b.replace("NIFTY ", ""),
}));

const TIMEFRAME_OPTIONS = TIMEFRAMES.map((t) => ({
  value: t,
  label: t.charAt(0).toUpperCase() + t.slice(1),
}));

const GROUP_OPTIONS = (Object.keys(SECTOR_GROUPS) as SectorGroup[]).map((g) => ({
  value: g,
  label: SECTOR_GROUPS[g].label,
}));

/**
 * Top-level client component for the RRG dashboard. Owns the five control
 * axes (benchmark, timeframe, tail, view group, replay date) and the
 * per-sector visibility override (click "solo" or toggle a row checkbox).
 *
 * Data is read directly from Supabase via fetchers in ../lib/fetchers.ts —
 * no backend API dependency on the read path.
 */
export function RRGDashboard() {
  const [benchmark, setBenchmark] = useState<Benchmark>(PRIMARY_BENCHMARK);
  const [timeframe, setTimeframe] = useState<Timeframe>("daily");
  const [tail, setTail] = useState<number>(3);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [pinnedToLatest, setPinnedToLatest] = useState(true);
  const [group, setGroup] = useState<SectorGroup>("classic");
  const [visibleOverride, setVisibleOverride] = useState<Set<string> | null>(null);

  const [tails, setTails] = useState<Record<string, RrgRow[]>>({});
  const [latestAsOf, setLatestAsOf] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Date axis — refetch when benchmark/timeframe changes
  useEffect(() => {
    let cancelled = false;
    fetchDates({ benchmark, timeframe })
      .then((res) => {
        if (cancelled) return;
        setDates(res);
        if (pinnedToLatest && res.length) {
          setAsOf(res[res.length - 1]);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [benchmark, timeframe, pinnedToLatest]);

  // Tails — refetch on any control change
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setLoading(true);
        return fetchTails({ benchmark, timeframe, tail, asOf });
      })
      .then((res) => {
        if (cancelled || !res) return;
        setTails(res.tails);
        setLatestAsOf(res.asOf);
        setError(null);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [benchmark, timeframe, tail, asOf]);

  // Alerts — refetch on (benchmark, timeframe)
  useEffect(() => {
    let cancelled = false;
    fetchAlerts({ benchmark, timeframe, limit: 100 })
      .then((res) => !cancelled && setAlerts(res))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [benchmark, timeframe]);

  const handleDateChange = useCallback(
    (date: string) => {
      setAsOf(date);
      setPinnedToLatest(date === dates[dates.length - 1]);
    },
    [dates],
  );

  const handleGroupChange = useCallback((g: SectorGroup) => {
    setGroup(g);
    setVisibleOverride(null);
  }, []);

  const handleToggleSector = useCallback(
    (symbol: string) => {
      setVisibleOverride((prev) => {
        const groupSet = new Set<string>(SECTOR_GROUPS[group].symbols);
        const current = prev ?? groupSet;
        const next = new Set(current);
        if (next.has(symbol)) next.delete(symbol);
        else next.add(symbol);
        if (
          next.size === groupSet.size &&
          [...groupSet].every((s) => next.has(s))
        ) {
          return null;
        }
        return next;
      });
    },
    [group],
  );

  const handleSoloSector = useCallback((symbol: string) => {
    setVisibleOverride(new Set([symbol]));
  }, []);

  const handleResetVisibility = useCallback(() => {
    setVisibleOverride(null);
  }, []);

  const visibleSet = useMemo(() => {
    if (visibleOverride) return visibleOverride;
    return new Set<string>(SECTOR_GROUPS[group].symbols);
  }, [group, visibleOverride]);

  const visibleTails = useMemo(() => {
    const out: Record<string, RrgRow[]> = {};
    for (const sym of Object.keys(tails)) {
      if (sym === benchmark) continue;
      if (!visibleSet.has(sym)) continue;
      out[sym] = tails[sym];
    }
    return out;
  }, [tails, visibleSet, benchmark]);

  const hasData = useMemo(
    () => Object.keys(visibleTails).length > 0,
    [visibleTails],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-card-border bg-card p-3">
        <Toggle<Benchmark>
          label="Benchmark"
          value={benchmark}
          options={BENCHMARK_OPTIONS}
          onChange={setBenchmark}
        />
        <Toggle<Timeframe>
          label="Timeframe"
          value={timeframe}
          options={TIMEFRAME_OPTIONS}
          onChange={setTimeframe}
        />
        <Toggle<SectorGroup>
          label="View"
          value={group}
          options={GROUP_OPTIONS}
          onChange={handleGroupChange}
        />
        <Toggle
          label="Tail"
          value={String(tail)}
          options={TAIL_OPTIONS}
          onChange={(v) => setTail(Number(v))}
        />
        <div className="ml-auto text-xs text-muted">
          {loading ? "loading…" : latestAsOf ? `as of ${latestAsOf}` : "no data"}
        </div>
      </div>

      <DateSlider dates={dates} value={asOf} onChange={handleDateChange} />

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {!hasData ? (
        <EmptyState />
      ) : (
        <div className="space-y-4">
          <QuadrantSummary tails={visibleTails} />

          <section className="min-w-0 rounded-lg border border-card-border bg-card p-2">
            <RRGChart tails={visibleTails} />
          </section>

          <TodaysPlaybook tails={visibleTails} alerts={alerts} asOf={latestAsOf} />

          <HowToRead />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <aside className="min-w-0 overflow-x-auto rounded-lg border border-card-border bg-card">
              <div className="flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-card-border">
                <span>
                  Sectors · {Object.keys(visibleTails).length} of{" "}
                  {SECTOR_GROUPS[group].symbols.length} shown
                </span>
                {visibleOverride && (
                  <button
                    type="button"
                    onClick={handleResetVisibility}
                    className="text-xs normal-case hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    show all in group
                  </button>
                )}
              </div>
              <SectorTable
                tails={tails}
                visibleSet={visibleSet}
                benchmark={benchmark}
                onToggle={handleToggleSector}
                onSolo={handleSoloSector}
              />
            </aside>
            <aside className="min-w-0 overflow-x-auto rounded-lg border border-card-border bg-card">
              <div className="flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-card-border">
                <span>Quadrant crossings</span>
                <span className="normal-case text-muted">
                  click row to jump chart →
                </span>
              </div>
              <AlertsPanel alerts={alerts} onJumpTo={handleDateChange} />
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-card-border bg-card p-8 text-sm text-muted">
      <p className="font-medium mb-2 text-foreground">No rotation data available.</p>
      <p>Choose another benchmark or timeframe, or return after the next market update.</p>
    </div>
  );
}
