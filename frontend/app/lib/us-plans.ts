import { fetchAPI, postAPI } from "./api";
import type { ConditionalPlan, ResearchSetup } from "./swing-research";
import type { USPackage } from "./us-research";

export type USPlan = Omit<ConditionalPlan, "earnings_state"> & {
  market: "US"; currency: "USD"; timezone: "America/New_York";
  source_snapshot_id: string; updated_at: string;
  filled: false; execution_readiness: "PLANNING_ONLY";
};
const ROOT = "/api/us/plans";
export const listUSPlans = () => fetchAPI<{ plans: USPlan[] }>(ROOT);

export async function loadUSPlan(plan: USPlan) {
  const [source, saved] = await Promise.all([
    fetchAPI<{ package: USPackage }>(`/api/us/research/packages/${plan.package_id}`),
    fetchAPI<{ plan: USPlan }>(`${ROOT}/${plan.id}?revision=${plan.revision}`),
  ]);
  const setup = source.package.setups.find(row => row.setup_version === saved.plan.setup_version);
  if (saved.plan.id !== plan.id || saved.plan.revision !== plan.revision ||
      source.package.id !== saved.plan.package_id || source.package.market !== "US" ||
      source.package.currency !== "USD" || source.package.state !== "final" ||
      !setup || setup.setup_id !== saved.plan.setup_id || setup.source_snapshot_id !== saved.plan.source_snapshot_id ||
      setup.symbol !== saved.plan.symbol || setup.signal !== saved.plan.direction) {
    throw new Error("Original US plan evidence could not be verified. No revision was opened.");
  }
  return { plan: saved.plan, data: source.package, setup };
}

export function saveUSPlan(id: string, data: USPackage, setup: ResearchSetup, existing: USPlan | null, fields: FormData) {
  if (data.state !== "final" || data.currency !== "USD" || data.market !== "US" ||
      !data.setups.some(row => row.setup_version === setup.setup_version)) {
    throw new Error("Choose a setup from final US research before saving a plan.");
  }
  if (existing && (existing.package_id !== data.id || existing.setup_version !== setup.setup_version)) {
    throw new Error("A different source requires a new plan.");
  }
  // Reuse the imported editor's explicit allowlist; never send owner/fill/event assertions.
  return postAPI<{ plan: USPlan }>(`${ROOT}/${id}`, {
    expected_revision: existing?.revision || 0, package_id: data.id, setup_version: setup.setup_version,
    trigger: Number(fields.get("trigger")), stop: Number(fields.get("stop")), expiry: fields.get("expiry"),
    capital: Number(fields.get("capital")), risk_pct: Number(fields.get("risk_pct")), allocation_cap_pct: Number(fields.get("allocation_cap_pct")),
    notes: fields.get("notes"), exit_policy: fields.get("exit_policy"), state: fields.get("state"),
  });
}
