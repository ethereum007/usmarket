export type StrikeScope = "near" | "all";

export function getAtmWindow<T extends { strike: number }>(
  rows: T[],
  spot: number,
  radius = 5,
): T[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const atmIndex = sorted.reduce(
    (best, row, index) =>
      Math.abs(row.strike - spot) < Math.abs(sorted[best].strike - spot) ? index : best,
    0,
  );
  return sorted.slice(Math.max(0, atmIndex - radius), Math.min(sorted.length, atmIndex + radius + 1));
}

export function getAtmStrike<T extends { strike: number }>(rows: T[], spot: number): number {
  return getAtmWindow(rows, spot, 0)[0]?.strike || 0;
}
