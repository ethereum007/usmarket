"use client";

import { cn } from "../../lib/utils";

export type ScannerTab = "cpr" | "patterns" | "vcp" | "volume" | "nr" | "bounce52w" | "instbuy";

interface Props {
  tab: ScannerTab;
  setTab: (t: ScannerTab) => void;
}

const tabs: { key: ScannerTab; label: string }[] = [
  { key: "cpr", label: "CPR Multi-TF" },
  { key: "patterns", label: "Chart Patterns" },
  { key: "vcp", label: "VCP" },
  { key: "volume", label: "Volume Profile" },
  { key: "nr", label: "NR Squeeze" },
  { key: "bounce52w", label: "52W Bounce" },
  { key: "instbuy", label: "Inst. Buying" },
];

export function ScannerTabs({ tab, setTab }: Props) {
  return (
    <div className="flex items-center gap-4">
      <h1 className="text-xl font-semibold">Scanner</h1>
      <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3 py-1.5 rounded text-xs font-medium transition-colors",
              tab === t.key
                ? "bg-accent text-white"
                : "text-muted hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
