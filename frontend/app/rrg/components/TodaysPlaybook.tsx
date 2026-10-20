"use client";

import { useMemo } from "react";

import { borderlineAxis, shortLabel } from "../lib/rrg";
import type { AlertRow, Quadrant, RrgRow } from "../lib/types";

type Props = {
  tails: Record<string, RrgRow[]>;
  alerts: AlertRow[];
  asOf: string | null;
};

const RECENT_BARS = 5;

type Bucket = {
  key: Quadrant;
  title: string;
  bg: string;
  pill: string;
  action: string;
  guidance: string;
};

const BUCKETS: Bucket[] = [
  {
    key: "leading",
    title: "Long bias — hold / add on pullbacks",
    bg: "bg-emerald-500/5",
    pill: "bg-emerald-500 text-white",
    action: "HOLD / ADD",
    guidance:
      "Outperforming with positive momentum. Existing longs work; on dips toward the centerline is a reasonable add-on zone.",
  },
  {
    key: "improving",
    title: "Best new-entry zone — accumulate small",
    bg: "bg-violet-500/5",
    pill: "bg-violet-500 text-white",
    action: "ACCUMULATE",
    guidance:
      "Underperforming but momentum is turning up. Cleanest risk/reward for fresh longs — start small, scale in as the sector breaks into Leading.",
  },
  {
    key: "weakening",
    title: "Take profits — trim, tighten stops",
    bg: "bg-amber-500/5",
    pill: "bg-amber-500 text-white",
    action: "TRIM",
    guidance:
      "Still outperforming but momentum is decelerating. Trade is maturing — book partials, raise stops. Don't add new size here.",
  },
  {
    key: "lagging",
    title: "Avoid — stay out until momentum turns",
    bg: "bg-rose-500/5",
    pill: "bg-rose-500 text-white",
    action: "AVOID",
    guidance:
      "Underperforming AND decelerating. No longs. Watch for the move into Improving — that's the early-warning signal to reconsider.",
  },
];

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000,
  );
}

export function TodaysPlaybook({ tails, alerts, asOf }: Props) {
  const entries = useMemo(() => {
    const out: Array<{
      symbol: string;
      quadrant: Quadrant;
      isNew: boolean;
      daysSinceEntry: number | null;
      borderline: ReturnType<typeof borderlineAxis>;
      ratio: number;
      momentum: number;
    }> = [];

    for (const [symbol, points] of Object.entries(tails)) {
      const head = points[points.length - 1];
      if (!head) continue;

      const entryAlert = alerts
        .filter((a) => a.symbol === symbol && a.to_quadrant === head.quadrant)
        .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))[0];

      const daysSinceEntry = entryAlert
        ? daysBetween(entryAlert.as_of_date, head.as_of_date)
        : null;

      const isNew =
        daysSinceEntry !== null && daysSinceEntry <= RECENT_BARS + 2;

      out.push({
        symbol,
        quadrant: head.quadrant,
        isNew,
        daysSinceEntry,
        borderline: borderlineAxis(head),
        ratio: head.rs_ratio,
        momentum: head.rs_momentum,
      });
    }
    return out;
  }, [tails, alerts]);

  const borderlineCount = entries.filter((e) => e.borderline !== null).length;

  const byBucket: Record<Quadrant, typeof entries> = {
    leading: [],
    improving: [],
    weakening: [],
    lagging: [],
  };
  for (const e of entries) byBucket[e.quadrant].push(e);
  for (const q of Object.keys(byBucket) as Quadrant[]) {
    byBucket[q].sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      const aBorder = a.borderline !== null;
      const bBorder = b.borderline !== null;
      if (aBorder !== bBorder) return aBorder ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  return (
    <section className="rounded-lg border border-card-border bg-card">
      <header className="flex items-baseline justify-between border-b border-card-border px-4 py-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Today&apos;s Playbook
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Action prompts per sector. <b className="text-warning">★ NEW</b> = entered this quadrant
            in the last week.{" "}
            <b className="text-muted">~ BORDERLINE</b> = sitting on a centerline, call is uncertain.
          </p>
        </div>
        <div className="text-right">
          {asOf && (
            <div className="text-xs text-muted tabular-nums">{asOf}</div>
          )}
          {borderlineCount > 0 && (
            <div className="text-[10px] text-muted mt-0.5">
              {borderlineCount} borderline · interpret with caution
            </div>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
        {BUCKETS.map((b) => {
          const list = byBucket[b.key];
          return (
            <div
              key={b.key}
              className={`rounded-lg border border-card-border ${b.bg} p-3`}
            >
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-semibold text-foreground">{b.title}</h3>
                <span
                  className={`px-2 py-0.5 text-[10px] font-bold rounded ${b.pill}`}
                >
                  {b.action}
                </span>
              </div>
              <p className="text-xs text-muted mb-2">{b.guidance}</p>
              {list.length === 0 ? (
                <p className="text-xs text-muted italic">No sectors here right now.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {list.map((e) => {
                    const tooltipParts: string[] = [];
                    if (e.daysSinceEntry !== null) {
                      tooltipParts.push(`Entered ${e.daysSinceEntry}d ago`);
                    }
                    tooltipParts.push(
                      `Ratio ${e.ratio.toFixed(2)} · Momentum ${e.momentum.toFixed(2)}`,
                    );
                    if (e.borderline === "momentum") {
                      tooltipParts.push(
                        `Momentum at boundary — could flip Leading↔Weakening or Improving↔Lagging next bar.`,
                      );
                    } else if (e.borderline === "ratio") {
                      tooltipParts.push(
                        `Ratio at boundary — could flip Leading↔Improving or Weakening↔Lagging next bar.`,
                      );
                    } else if (e.borderline === "both") {
                      tooltipParts.push(
                        `Both axes on centerlines — weakest possible signal.`,
                      );
                    }

                    return (
                      <li
                        key={e.symbol}
                        className={`text-xs px-2 py-0.5 rounded border bg-card ${
                          e.isNew
                            ? "border-card-border font-semibold"
                            : e.borderline
                              ? "border-dashed border-muted italic"
                              : "border-card-border"
                        }`}
                        title={tooltipParts.join(" • ")}
                      >
                        {e.isNew && <span className="text-warning mr-0.5">★</span>}
                        {e.borderline && !e.isNew && (
                          <span className="text-muted mr-0.5">~</span>
                        )}
                        {shortLabel(e.symbol)}
                        {e.isNew && e.daysSinceEntry !== null && (
                          <span className="text-muted ml-1">{e.daysSinceEntry}d</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
