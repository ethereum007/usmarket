"use client";

import Link from "next/link";

const actions = [
  {
    title: "Options Chain",
    description: "Live OI, Greeks, PCR, Max Pain for NIFTY & BANKNIFTY",
    href: "/options",
  },
  {
    title: "CPR Scanner",
    description: "Multi-timeframe CPR + PEMA signals for Nifty 500",
    href: "/trade-ideas",
  },
  {
    title: "F&O Dashboard",
    description: "Futures chain, rollover data, OI analysis",
    href: "/options?tab=fno",
  },
  {
    title: "Stock Screener",
    description: "Buying pressure, breakout radar, sector heatmap",
    href: "/stocks",
  },
];

export function QuickActions() {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Quick Access</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {actions.map((a) => (
          <Link
            key={a.title}
            href={a.href}
            className="group rounded-lg border border-card-border bg-card p-4 transition-colors hover:bg-hover-bg"
          >
            <h3 className="font-medium mb-1 group-hover:text-accent transition-colors">
              {a.title}
            </h3>
            <p className="text-xs text-muted leading-relaxed">{a.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
