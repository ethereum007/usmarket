"use client";

import { useMemo, useState } from "react";
import { formatNumber, cn } from "../../lib/utils";
import { StrikeScopeToggle } from "./StrikeScopeToggle";
import { getAtmStrike, getAtmWindow, type StrikeScope } from "./strikeScope";

interface StrikeRow {
  strike: number;
  call: {
    oi: number;
    oiChange: number;
    volume: number;
    ltp: number;
    iv: number | null;
  } | null;
  put: {
    oi: number;
    oiChange: number;
    volume: number;
    ltp: number;
    iv: number | null;
  } | null;
}

interface Props {
  chain: StrikeRow[];
  spot: number;
  strikeStep: number;
}

function formatOI(n: number): string {
  if (n >= 10000000) return (n / 10000000).toFixed(1) + "Cr";
  if (n >= 100000) return (n / 100000).toFixed(1) + "L";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

function oiBar(oi: number, maxOI: number): number {
  return maxOI > 0 ? (oi / maxOI) * 100 : 0;
}

export function OptionChainTable({ chain, spot, strikeStep }: Props) {
  const [scope, setScope] = useState<StrikeScope>("near");
  const sorted = useMemo(() => [...chain].sort((a, b) => a.strike - b.strike), [chain]);
  const filtered = useMemo(
    () => scope === "all" ? sorted : getAtmWindow(sorted, spot, 5),
    [scope, sorted, spot],
  );

  const maxCallOI = Math.max(...filtered.map((s) => s.call?.oi || 0));
  const maxPutOI = Math.max(...filtered.map((s) => s.put?.oi || 0));

  const atmStrike = getAtmStrike(sorted, spot);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-hover/45 px-4 py-2.5">
        <p className="text-xs text-muted">
          Showing <span className="font-bold text-foreground">{filtered.length}</span> strikes around spot
          {strikeStep > 0 && <span> · step {formatNumber(strikeStep, 0)}</span>}
        </p>
        <StrikeScopeToggle value={scope} onChange={setScope} total={sorted.length} compact />
      </div>
      <div className={cn("overflow-auto", scope === "all" && "max-h-[calc(100vh-360px)]")}>
      <table className="w-full min-w-[980px] text-xs font-mono">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-card-border text-muted">
            <th className="text-right px-2 py-2">OI Chg</th>
            <th className="text-right px-2 py-2">OI</th>
            <th className="text-right px-2 py-2">Vol</th>
            <th className="text-right px-2 py-2">IV</th>
            <th className="text-right px-2 py-2">LTP</th>
            <th className="text-center px-3 py-2 font-bold text-foreground">STRIKE</th>
            <th className="text-left px-2 py-2">LTP</th>
            <th className="text-left px-2 py-2">IV</th>
            <th className="text-left px-2 py-2">Vol</th>
            <th className="text-left px-2 py-2">OI</th>
            <th className="text-left px-2 py-2">OI Chg</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((row) => {
            const isATM = row.strike === atmStrike;
            const isITMCall = row.strike < spot;
            const isITMPut = row.strike > spot;

            return (
              <tr
                key={row.strike}
                className={cn(
                  "border-b border-card-border/50 hover:bg-hover-bg transition-colors",
                  isATM && "bg-accent-bg border-accent/20"
                )}
              >
                {/* CALL side */}
                <td
                  className={cn(
                    "text-right px-2 py-1.5",
                    isITMCall && "bg-hover-bg",
                    row.call && row.call.oiChange > 0 ? "text-profit" : "text-loss"
                  )}
                >
                  {row.call ? formatOI(row.call.oiChange) : "-"}
                </td>
                <td className={cn("text-right px-2 py-1.5 relative", isITMCall && "bg-hover-bg")}>
                  <div
                    className="absolute inset-y-0 right-0 bg-loss/10"
                    style={{ width: `${oiBar(row.call?.oi || 0, maxCallOI)}%` }}
                  />
                  <span className="relative">{row.call ? formatOI(row.call.oi) : "-"}</span>
                </td>
                <td className={cn("text-right px-2 py-1.5", isITMCall && "bg-hover-bg")}>
                  {row.call ? formatOI(row.call.volume) : "-"}
                </td>
                <td className={cn("text-right px-2 py-1.5 text-muted", isITMCall && "bg-hover-bg")}>
                  {row.call?.iv ?? "-"}
                </td>
                <td className={cn("text-right px-2 py-1.5 font-medium", isITMCall && "bg-hover-bg")}>
                  {row.call ? formatNumber(row.call.ltp) : "-"}
                </td>

                {/* STRIKE */}
                <td
                  className={cn(
                    "text-center px-3 py-1.5 font-bold border-x border-card-border",
                    isATM ? "text-accent bg-accent-bg" : "text-foreground"
                  )}
                >
                  {formatNumber(row.strike, 0)}
                  {isATM && <span className="ml-1 text-[10px] text-accent">ATM</span>}
                </td>

                {/* PUT side */}
                <td className={cn("text-left px-2 py-1.5 font-medium", isITMPut && "bg-hover-bg")}>
                  {row.put ? formatNumber(row.put.ltp) : "-"}
                </td>
                <td className={cn("text-left px-2 py-1.5 text-muted", isITMPut && "bg-hover-bg")}>
                  {row.put?.iv ?? "-"}
                </td>
                <td className={cn("text-left px-2 py-1.5", isITMPut && "bg-hover-bg")}>
                  {row.put ? formatOI(row.put.volume) : "-"}
                </td>
                <td className={cn("text-left px-2 py-1.5 relative", isITMPut && "bg-hover-bg")}>
                  <div
                    className="absolute inset-y-0 left-0 bg-profit/10"
                    style={{ width: `${oiBar(row.put?.oi || 0, maxPutOI)}%` }}
                  />
                  <span className="relative">{row.put ? formatOI(row.put.oi) : "-"}</span>
                </td>
                <td
                  className={cn(
                    "text-left px-2 py-1.5",
                    isITMPut && "bg-hover-bg",
                    row.put && row.put.oiChange > 0 ? "text-profit" : "text-loss"
                  )}
                >
                  {row.put ? formatOI(row.put.oiChange) : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
