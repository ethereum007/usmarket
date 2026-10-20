/** Priority is an ordering of review criteria, never a probability or trade score. */
export type PrioritySignal = {
  type: string;
  signalTime: string;
  entryAssessment?: {
    status: string;
    asOf: string;
    remainingRewardRisk?: number | null;
    checks: { label: string; passed: boolean }[];
  };
};
export type PriorityCandidate = { symbol: string; direction: string; score?: number | null; signals: PrioritySignal[] };
export type PriorityContext = { now: number; stale: boolean; marketOpen: boolean };
export type Priority = { group: number; groupLabel: string; agreement: number; age: number; rewardRisk: number; radarScore: number; reason: string; status: string };

export function entryStatus(signal: PrioritySignal | undefined, context: PriorityContext): string {
  if (context.stale) return "DATA_CHECK";
  if (!context.marketOpen) return "MARKET_CLOSED";
  if (!signal) return "NO_CONFIRMATION";
  const assessment = signal.entryAssessment;
  const checkedAt = assessment ? Date.parse(assessment.asOf) : NaN;
  const confirmedAt = Date.parse(signal.signalTime);
  if (!assessment || !Number.isFinite(checkedAt) || checkedAt > context.now || context.now - checkedAt > 90_000
    || !Number.isFinite(confirmedAt) || confirmedAt > context.now) return "DATA_CHECK";
  if (context.now - confirmedAt > 15 * 60_000 && ["CHECKS_PASSED", "WAIT", "EXTENDED"].includes(assessment.status)) return "EXPIRED";
  return assessment.status;
}

export function priorityFor(candidate: PriorityCandidate, selected: PrioritySignal | undefined, context: PriorityContext): Priority {
  let status = entryStatus(selected, context);
  // A missing basis is only a watch candidate if another basis has usable data.
  if (status === "NO_CONFIRMATION" && !candidate.signals.some(s => ["CHECKS_PASSED", "WAIT"].includes(entryStatus(s, context)))) status = "DATA_CHECK";
  const group = status === "CHECKS_PASSED" ? 0 : ["WAIT", "NO_CONFIRMATION"].includes(status) ? 1
    : ["EXTENDED", "EXPIRED", "TARGET_REACHED", "MARKET_CLOSED", "SUPERSEDED"].includes(status) ? 2 : 3;
  // One vote per basis, from the newest event; old confirmations cannot inflate rank.
  const latest = new Map<string, PrioritySignal>();
  for (const signal of candidate.signals) {
    const prior = latest.get(signal.type);
    if (!prior || Date.parse(prior.signalTime) < Date.parse(signal.signalTime)) latest.set(signal.type, signal);
  }
  const agreement = [...latest.values()].filter(signal => entryStatus(signal, context) === "CHECKS_PASSED").length;
  const confirmedAt = selected ? Date.parse(selected.signalTime) : NaN;
  const age = Number.isFinite(confirmedAt) ? Math.max(0, (context.now - confirmedAt) / 60_000) : Infinity;
  const rr = selected?.entryAssessment?.remainingRewardRisk;
  const rewardRisk = rr != null && Number.isFinite(rr) ? rr : -Infinity;
  const radarScore = candidate.score != null && Number.isFinite(candidate.score) ? candidate.score : -Infinity;
  const groupLabel = ["Entry checks passed", "Watch for confirmation", "Review only", "Invalidated / data check"][group];
  const reason = group === 0
    ? `${agreement} current confirmation${agreement === 1 ? "" : "s"} · ${age.toFixed(1)} min old · ${Number.isFinite(rewardRisk) ? rewardRisk.toFixed(2) : "—"}R remaining`
    : group === 1 ? "Watch candidate; entry checks have not all passed." : "Outside current entry priorities.";
  return { group, groupLabel, agreement, age, rewardRisk, radarScore, reason, status };
}

export function comparePriority(a: Priority, b: Priority, aKey: string, bKey: string): number {
  // Avoid Infinity - Infinity (NaN) when an assessment or quote is unavailable.
  for (const [left, right, direction] of [[a.group, b.group, 1], [a.agreement, b.agreement, -1],
    [a.age, b.age, 1], [a.rewardRisk, b.rewardRisk, -1], [a.radarScore, b.radarScore, -1]]) {
    if (left !== right) return (left < right ? -1 : 1) * direction;
  }
  return aKey.localeCompare(bKey);
}
