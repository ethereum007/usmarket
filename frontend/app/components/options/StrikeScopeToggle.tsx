"use client";

import { cn } from "../../lib/utils";
import type { StrikeScope } from "./strikeScope";

interface Props {
  value: StrikeScope;
  onChange: (value: StrikeScope) => void;
  total: number;
  compact?: boolean;
}

export function StrikeScopeToggle({ value, onChange, total, compact = false }: Props) {
  return (
    <div className="inline-flex rounded-lg bg-surface-hover p-1" role="group" aria-label="Strike range">
      <button
        type="button"
        aria-pressed={value === "near"}
        onClick={() => onChange("near")}
        className={cn(
          "rounded-md px-3 font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          compact ? "min-h-8 text-[11px]" : "min-h-9 text-xs",
          value === "near" ? "bg-card text-accent shadow-sm" : "text-muted hover:text-foreground",
        )}
      >
        ATM ±5
      </button>
      <button
        type="button"
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
        className={cn(
          "rounded-md px-3 font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          compact ? "min-h-8 text-[11px]" : "min-h-9 text-xs",
          value === "all" ? "bg-card text-accent shadow-sm" : "text-muted hover:text-foreground",
        )}
      >
        All {total > 0 ? `(${total})` : ""}
      </button>
    </div>
  );
}
