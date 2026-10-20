export type ReviewPriority = { level: "high" | "medium" | "low"; score: number; reason: string; check: string };
type Signal = { event_type: string; materiality?: string; confidence?: string; source_url: string | null; metadata?: { review_priority?: ReviewPriority; is_repeat?: boolean; novelty?: string } | null };
const checks: Record<string, string> = {
  order_win: "Check order size against annual revenue, execution period and margins.",
  m_and_a: "Check consideration, funding, ownership acquired and closing conditions.",
  fundraising: "Check dilution, issue price, funding cost and use of proceeds.",
  partnership_jv: "Check binding commitments, investment required and commercial timeline.",
  capex: "Check capacity change, investment, funding and commissioning timeline.",
  product_license: "Check approval scope, launch timeline and addressable sales.",
  regulatory_action: "Check the order's scope, financial exposure and operating restrictions.",
  litigation_arbitration: "Check financial exposure, enforceability and appeal deadlines.",
  capital_return: "Check payout size, eligibility dates and effect on cash reserves.",
  credit_rating: "Check rating change, outlook and impact on borrowing costs.",
  business_update: "Compare the disclosed change with prior periods and guidance.",
};
export function reviewPriority(signal: Signal): ReviewPriority {
  const stored = signal.metadata?.review_priority;
  if (stored && ["high", "medium", "low"].includes(stored.level) && Number.isFinite(stored.score) && typeof stored.reason === "string" && typeof stored.check === "string") return stored;
  const materiality = signal.materiality || "unknown";
  const confidence = signal.confidence || "low";
  let source = false;
  try { const url = new URL(signal.source_url || ""); source = url.protocol === "https:" && (url.hostname === "nseindia.com" || url.hostname.endsWith(".nseindia.com")); } catch { /* Missing source stays unverified. */ }
  const repeat = signal.metadata?.is_repeat === true || signal.metadata?.novelty === "repeat";
  let score = ({ high: 55, medium: 30, low: 10 } as Record<string, number>)[materiality] ?? 15;
  score += ({ high: 20, medium: 10 } as Record<string, number>)[confidence] ?? 0;
  score += source ? 10 : 0;
  if (repeat || materiality === "low") score = Math.min(score, 25);
  const level = score >= 70 && materiality === "high" && confidence !== "low" && source ? "high" : score >= 35 ? "medium" : "low";
  let reason = ({ high: "The classifier flags substantial business impact.", medium: "The classifier flags a meaningful business development.", low: "The classifier flags limited business impact." } as Record<string, string>)[materiality] ?? "Business impact is not yet established; company-relative size needs checking.";
  if (repeat) reason = "Repeated disclosure of the same development; review the newest filing first.";
  reason += ({ high: " Evidence rating: high.", medium: " Evidence rating: medium.", low: " Evidence is incomplete; verify the filing." } as Record<string, string>)[confidence] ?? " Evidence rating is unavailable.";
  if (!source) reason += " Original NSE link is unavailable.";
  return { level, score, reason, check: checks[signal.event_type] || "Check the original filing and establish company-relative impact." };
}
export const priorityOrder = { high: 0, medium: 1, low: 2 };
export function comparePriority(a: Signal & { event_date: string | null; id: string }, b: Signal & { event_date: string | null; id: string }) {
  const pa = reviewPriority(a), pb = reviewPriority(b);
  return priorityOrder[pa.level] - priorityOrder[pb.level] || pb.score - pa.score || (b.event_date || "").localeCompare(a.event_date || "") || a.id.localeCompare(b.id);
}
