"use client";

import { cn } from "../../lib/utils";

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  label?: string;
};

/**
 * Tiny segmented control. Stateless — parent owns the value. Themed to match
 * Alpha Radar's card/accent tokens.
 */
export function Toggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: Props<T>) {
  return (
    <div className="flex items-center gap-2">
      {label && (
        <span className="text-[10px] uppercase tracking-wider text-muted">
          {label}
        </span>
      )}
      <div className="inline-flex rounded-md border border-card-border bg-card p-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={opt.value === value}
            onClick={() => onChange(opt.value)}
            className={cn(
              "px-3 py-1 text-sm rounded transition-colors",
              opt.value === value
                ? "bg-accent text-white"
                : "text-muted hover:text-foreground hover:bg-hover-bg",
            )}
            style={{
              ...(opt.value === value
                ? { background: "var(--accent-solid)", color: "white" }
                : {}),
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
