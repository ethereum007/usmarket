import { fetchAPI } from "./api";

export type RefreshJob = { id: string; state: string; error?: string; package_id?: string };

// One observation per effect lifetime. A transport failure is not a job outcome.
export function observeRefresh(job: RefreshJob | null, onStatus: (job: RefreshJob) => void,
  onUnavailable: (message: string) => void): () => void {
  if (!job || !["queued", "running"].includes(job.state)) return () => {};
  let active = true;
  const timer = setTimeout(async () => {
    try {
      const result = await fetchAPI<{ job: RefreshJob }>(`/api/us/research/jobs/${encodeURIComponent(job.id)}`);
      if (result.job.id !== job.id || !["queued", "running", "completed", "failed", "interrupted"].includes(result.job.state)) {
        throw new Error("Unexpected refresh status");
      }
      if (active) onStatus(result.job);
    } catch {
      if (active) onUnavailable("Refresh status could not be checked. The last recorded outcome is unchanged. Check again or inspect saved research.");
    }
  }, 2500);
  return () => { active = false; clearTimeout(timer); };
}
