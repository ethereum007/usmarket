"use client";

import type { RrgRow } from "../lib/types";
import { shortLabel } from "../lib/rrg";

type Props = {
  tails: Record<string, RrgRow[]>;
};

const QUADRANTS = [
  {
    key: "leading",
    label: "Leading",
    arrow: "↗",
    style: "bg-profit/10 text-profit",
  },
  {
    key: "weakening",
    label: "Weakening",
    arrow: "↓",
    style: "bg-warning/10 text-warning",
  },
  {
    key: "lagging",
    label: "Lagging",
    arrow: "↙",
    style: "bg-loss/10 text-loss",
  },
  {
    key: "improving",
    label: "Improving",
    arrow: "↑",
    style: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
] as const;

/**
 * At-a-glance count of sectors per quadrant — the "headline" above the chart.
 * Read the regime in one second before drilling into the chart itself.
 */
export function QuadrantSummary({ tails }: Props) {
  const counts: Record<string, string[]> = {
    leading: [],
    weakening: [],
    lagging: [],
    improving: [],
  };
  for (const [symbol, points] of Object.entries(tails)) {
    const head = points[points.length - 1];
    if (!head) continue;
    counts[head.quadrant].push(shortLabel(symbol));
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {QUADRANTS.map((q) => {
        const list = counts[q.key];
        return (
          <div
            key={q.key}
            className={`rounded-lg border border-card-border px-3 py-2 ${q.style}`}
          >
            <div className="flex items-center justify-between text-xs uppercase tracking-wide font-semibold">
              <span>{q.arrow} {q.label}</span>
              <span className="tabular-nums opacity-70">{list.length}</span>
            </div>
            <div className="mt-1 text-xs leading-snug line-clamp-2 opacity-80">
              {list.length ? list.join(" · ") : "—"}
            </div>
          </div>
        );
      })}
    </div>
  );
}
