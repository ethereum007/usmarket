"use client";

import Link from "next/link";
import { cn } from "../../lib/utils";

export function PremiumBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded bg-warning/15 px-1 text-[10px] font-extrabold leading-none text-warning ring-1 ring-warning/25",
        className
      )}
      title="Premium"
    >
      P
    </span>
  );
}

export function PremiumLocked({
  title = "Premium segment",
  description = "Upgrade to Premium to unlock this section.",
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("bg-card border border-card-border rounded-lg p-8 text-center", className)}>
      <div className="mb-3 flex justify-center">
        <PremiumBadge className="h-7 min-w-7 text-sm" />
      </div>
      <h2 className="text-base font-bold text-text-heading mb-2">{title}</h2>
      <p className="mx-auto mb-5 max-w-md text-sm leading-relaxed text-text-secondary">
        {description}
      </p>
      <Link
        href="/subscription"
        className="inline-flex items-center justify-center rounded-md bg-accent px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-accent/80"
      >
        Upgrade
      </Link>
    </div>
  );
}
