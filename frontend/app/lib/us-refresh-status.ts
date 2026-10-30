import { fetchAPI } from "./api";

export type RefreshJob = { id: string; state: string; error?: string; package_id?: string; updated_at?: string };

// One observation per effect lifetime. A transport failure is not a job outcome.
export function observeRefresh(job: RefreshJob | null, onStatus: (job: RefreshJob) => void,
  onUnavailable: (message: string) => void): () => void {
  if (!job || !["queued", "running"].includes(job.state)) return () => {};
  let active = true;
  const timer = setTimeout(async () => {
    try {
      const result = await fetchAPI<{ job: RefreshJob }>(`/api/us/research/jobs/${encodeURIComponent(job.id)}`);
      const [observation] = validateRefreshHistory([result.job]);
      if (observation.id !== job.id) throw new Error("Unexpected refresh identity");
      if (active) onStatus(observation);
    } catch {
      if (active) onUnavailable("Refresh status could not be checked. The last recorded outcome is unchanged. Check again or inspect saved research.");
    }
  }, 2500);
  return () => { active = false; clearTimeout(timer); };
}


// Validate before rendering history or selecting recovery work.
export function validateRefreshHistory(value: unknown): RefreshJob[] {
  const jobs = value as RefreshJob[];
  if (!Array.isArray(jobs) || jobs.length > 20) throw new Error("Invalid refresh history");
  const identities = new Set<string>();
  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || !job.id || identities.has(job.id) ||
        !["queued", "running", "completed", "failed", "interrupted"].includes(job.state)) throw new Error("Invalid refresh history");
    if (job.state === "completed" && (typeof job.package_id !== "string" || !/^[a-f0-9]{64}$/.test(job.package_id))) throw new Error("Invalid completed research identity");
    if ((job.updated_at !== undefined && typeof job.updated_at !== "string") || (job.error !== undefined && typeof job.error !== "string")) throw new Error("Invalid refresh display fields");
    identities.add(job.id);
  }
  if (jobs.filter(job => ["queued", "running"].includes(job.state)).length > 1) throw new Error("Ambiguous active refresh history");
  return jobs;
}

// Rediscover only recorded active work; never infer liveness or restart a worker.
export async function restoreActiveRefresh(): Promise<RefreshJob | null> {
  const result = await fetchAPI<{ jobs: RefreshJob[] }>("/api/us/research/jobs");
  const jobs = validateRefreshHistory(result.jobs);
  const active = jobs.filter(job => ["queued", "running"].includes(job.state));
  if (active.length > 1) throw new Error("Ambiguous active refresh history");
  return active[0] || null;
}
