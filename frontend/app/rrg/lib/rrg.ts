import type { RrgRow } from "./types";

// Within ±0.5 of either centerline = "borderline" — quadrant call is
// unreliable, sector could flip on the next bar. Surfaced as a ~ badge.
export const BORDERLINE_BAND = 0.5;

export function isBorderline(row: RrgRow): boolean {
  return (
    Math.abs(row.rs_ratio - 100) < BORDERLINE_BAND ||
    Math.abs(row.rs_momentum - 100) < BORDERLINE_BAND
  );
}

export function borderlineAxis(
  row: RrgRow,
): "momentum" | "ratio" | "both" | null {
  const nearRatio = Math.abs(row.rs_ratio - 100) < BORDERLINE_BAND;
  const nearMomentum = Math.abs(row.rs_momentum - 100) < BORDERLINE_BAND;
  if (nearRatio && nearMomentum) return "both";
  if (nearMomentum) return "momentum";
  if (nearRatio) return "ratio";
  return null;
}

// Strip "NIFTY " prefix for chart and table labels. Every sector starts
// with it so it's pure visual noise.
export function shortLabel(symbol: string): string {
  return symbol.replace(/^NIFTY\s+/i, "");
}
