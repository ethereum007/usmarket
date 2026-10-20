"use client";

import { cn } from "../../lib/utils";

import { shortLabel } from "../lib/rrg";
import type { AlertRow, Quadrant } from "../lib/types";

type Props = {
  alerts: AlertRow[];
  onJumpTo?: (date: string) => void;
};

const QUADRANT_TEXT: Record<Quadrant, string> = {
  leading: "text-profit",
  weakening: "text-warning",
  lagging: "text-loss",
  improving: "text-violet-700 dark:text-violet-300",
};

// Must mirror INTERESTING_TRANSITIONS in alpha-radar-backend/app/engines/rrg.py
// (currently surfaced only as a visual highlight here; backend uses the same
// set if email dispatch is wired up later).
const INTERESTING_KEY = new Set([
  "improving>leading",
  "leading>weakening",
  "lagging>improving",
  "weakening>lagging",
]);

function isInteresting(a: AlertRow): boolean {
  return INTERESTING_KEY.has(`${a.from_quadrant}>${a.to_quadrant}`);
}

export function AlertsPanel({ alerts, onJumpTo }: Props) {
  if (alerts.length === 0) {
    return (
      <div className="text-sm text-muted px-3 py-4">
        No quadrant crossings yet — check back after the next EOD job.
      </div>
    );
  }

  return (
    <div className="text-sm">
      <div className="grid grid-cols-[minmax(6rem,1fr)_minmax(11rem,auto)_5.5rem] gap-3 px-3 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-card-border">
        <span>Sector</span>
        <span>Transition</span>
        <span className="text-right">Date</span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        {alerts.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onJumpTo?.(a.as_of_date)}
            className={cn(
              "grid w-full grid-cols-[minmax(6rem,1fr)_minmax(11rem,auto)_5.5rem] gap-3 items-center px-3 py-1.5 border-b border-card-border/50 text-left hover:bg-hover-bg",
              isInteresting(a) && "bg-amber-500/5",
            )}
            style={isInteresting(a) ? { background: "var(--accent-bg)" } : undefined}
            title={`${a.symbol} — jump to ${a.as_of_date}`}
          >
            <span className="truncate font-medium text-foreground">{shortLabel(a.symbol)}</span>
            <span className="text-xs uppercase tracking-wide">
              <span className={QUADRANT_TEXT[a.from_quadrant]}>{a.from_quadrant}</span>
              <span className="mx-1 text-muted">→</span>
              <span className={cn("font-semibold", QUADRANT_TEXT[a.to_quadrant])}>{a.to_quadrant}</span>
            </span>
            <span className="text-right tabular-nums text-muted">{a.as_of_date}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
