import { APIError, postAPI } from "./api";
import type { RefreshJob } from "./us-refresh-status";
export type RefreshSubmission = { active: boolean; pending: boolean };
export async function submitRefresh(payload: { symbols: string; benchmark: string; feed: string },
  lifecycle: RefreshSubmission, onJob: (job: RefreshJob) => void,
  onError: (message: string) => void, onPending: (pending: boolean) => void): Promise<void> {
  if (!lifecycle.active || lifecycle.pending) return;
  lifecycle.pending = true; onPending(true); onError("");
  try {
    const result = await postAPI<{ job: RefreshJob }>("/api/us/research/refresh", payload);
    if (!result.job || result.job.state !== "queued" || typeof result.job.id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.job.id)) throw new Error("Invalid refresh acknowledgement");
    if (lifecycle.active) onJob({ id: result.job.id, state: "queued" });
  } catch (cause) {
    if (lifecycle.active) {
      if (cause instanceof APIError && cause.status === 429) {
        const wait = cause.retryAfterSeconds ? ` Wait at least ${cause.retryAfterSeconds} seconds before trying again.` : " Wait before trying again.";
        onError("Refresh capacity is busy." + wait + " No refresh was confirmed; check refresh history before retrying.");
      } else if (cause instanceof APIError && cause.status === 409) {
        onError("Refresh admission conflicts with recorded work. Reload refresh history and check saved research before trying again.");
      } else {
        onError("Refresh request was not confirmed. Check the symbols and reload refresh history before retrying.");
      }
    }
  } finally {
    lifecycle.pending = false;
    if (lifecycle.active) onPending(false);
  }
}
