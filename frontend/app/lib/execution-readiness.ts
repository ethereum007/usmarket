/** Mandatory execution checks, independent of the research ranking score. */
export function executionBlockers(input: {
  researchOnly: boolean;
  marketOpen: boolean;
  freshness: string;
  ageSeconds: number | null;
  spreadPct: number | null;
  liquidityScore: number;
  entry: number;
  stop: number | null;
  bias: string;
  quotePrice: number | null;
  quoteReceivedAt: number | null;
  now: number;
  feedError: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.researchOnly) reasons.push("Saved research/replay requires a separate live confirmation.");
  if (!input.marketOpen) reasons.push("Market is closed: research and planning only.");
  if (input.freshness !== "fresh" || input.ageSeconds == null || !Number.isFinite(input.ageSeconds) || input.ageSeconds < 0 || input.ageSeconds > 90) {
    reasons.push("Setup freshness is not verified for live execution.");
  }
  if (input.quotePrice == null || !Number.isFinite(input.quotePrice) || input.quotePrice <= 0 || input.quoteReceivedAt == null || input.now - input.quoteReceivedAt > 90000 || input.now < input.quoteReceivedAt) {
    reasons.push("A recent live quote is required.");
  }
  if (input.spreadPct == null || !Number.isFinite(input.spreadPct) || input.spreadPct < 0 || input.spreadPct > 0.12) {
    reasons.push("Bid/ask spread is missing, crossed, or too wide.");
  }
  if (!Number.isFinite(input.liquidityScore) || input.liquidityScore < 55) reasons.push("Liquidity is insufficient for entry confirmation.");
  const validStop = input.stop != null && Number.isFinite(input.stop) && input.stop > 0 &&
    ((input.bias === "LONG" && input.stop < input.entry) || (input.bias === "SHORT" && input.stop > input.entry));
  if (!Number.isFinite(input.entry) || input.entry <= 0 || !validStop) reasons.push("Directional entry and invalidation levels are required.");
  if (input.feedError) reasons.push("A context feed is unavailable.");
  return reasons;
}
