"use client";

import { PageHeader } from "../components/layout/PageHeader";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Database, RefreshCw } from "lucide-react";
import { fetchAPI, postAPI } from "../lib/api";
import { cn } from "../lib/utils";

type SnapshotStatus = "fresh" | "last-session" | "stale" | "missing" | "unknown";
type Tone = "profit" | "warning" | "loss" | "neutral";
type SnapshotWarmState = "running" | "success" | "error";

interface SnapshotRow {
  key: string;
  label: string;
  group: string;
  available: boolean;
  status: SnapshotStatus;
  timestamp?: string | null;
  savedAt?: number | null;
  ageSeconds?: number | null;
  ageLabel?: string | null;
  bytes?: number | null;
  path?: string | null;
  source?: SnapshotSource | null;
}

interface SnapshotSource {
  method?: string | null;
  endpoint?: string | null;
  page?: string | null;
  requiresPremium?: boolean;
  requiresBroker?: boolean;
  hint?: string | null;
}

interface SnapshotStatusResponse {
  success?: boolean;
  summary?: {
    tracked?: number;
    available?: number;
    missing?: number;
    freshest?: SnapshotRow | null;
    stalest?: SnapshotRow | null;
    needsSeeding?: boolean;
    nextSeed?: SnapshotSeedQueueItem | null;
    replayReadiness?: SnapshotReadiness | null;
  };
  snapshots?: SnapshotRow[];
  seedQueue?: SnapshotSeedQueueItem[];
}

interface SnapshotReadiness {
  score: number;
  label: string;
  mode: string;
  tracked: number;
  ready: number;
  needsAttention: number;
  blocked: number;
  canSeedNow: number;
  action: string;
  byGroup?: SnapshotReadinessGroup[];
}

interface SnapshotReadinessGroup {
  group: string;
  score: number;
  tracked: number;
  ready: number;
  needsAttention: number;
}

interface SnapshotDetailResponse {
  success?: boolean;
  snapshot: SnapshotRow;
  data: unknown;
}

interface SnapshotSeedQueueItem {
  key: string;
  label: string;
  group: string;
  status: SnapshotStatus;
  ageSeconds?: number | null;
  ageLabel?: string | null;
  priority?: number;
  reason?: string;
  blockedBy?: string[];
  canSeedNow?: boolean;
  source?: SnapshotSource | null;
}

interface SnapshotWarmer {
  label: string;
}

interface SnapshotWarmStatus {
  state: SnapshotWarmState;
  message: string;
}

interface SnapshotWarmResult {
  key: string;
  label: string;
  status: "WARMED" | "FAILED" | "SKIPPED" | string;
  message: string;
  statusCode?: number;
}

interface SnapshotWarmResponse {
  success?: boolean;
  requested: number;
  warmed: number;
  failed: number;
  skipped: number;
  results: SnapshotWarmResult[];
  snapshotStatus?: SnapshotStatusResponse;
}

const PREVIEW_LIMIT = 25;
const JSON_LIMIT = 18_000;
const SNAPSHOT_WARMERS: Record<string, SnapshotWarmer> = {
  indices: { label: "Warm" },
  quote_sectors: { label: "Warm" },
  hot_cold_indices: { label: "Warm" },
  breadth: { label: "Warm" },
  top_movers: { label: "Warm" },
  pulse: { label: "Warm replay" },
  intraday_radar: { label: "Warm replay" },
  abnormal_live: { label: "Warm replay" },
  live_signals: { label: "Warm" },
  orb_signals: { label: "Warm" },
  "52w_bounce": { label: "Warm" },
  sector_momentum: { label: "Warm" },
  swing_spectrum: { label: "Warm replay" },
};
const PREFERRED_COLUMNS = [
  "symbol",
  "name",
  "label",
  "sector",
  "bias",
  "signal",
  "status",
  "ltp",
  "last",
  "last_price",
  "changePct",
  "changePercent",
  "score",
  "volume",
];

export default function SnapshotsPageWrapper() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse text-accent">Loading snapshots...</div>}>
      <SnapshotsPage />
    </Suspense>
  );
}

function SnapshotsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedKey = searchParams.get("key");
  const requestedGroup = searchParams.get("group");
  const [status, setStatus] = useState<SnapshotStatusResponse | null>(null);
  const [detail, setDetail] = useState<SnapshotDetailResponse | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(requestedKey);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [warmingKey, setWarmingKey] = useState<string | null>(null);
  const [bulkWarming, setBulkWarming] = useState(false);
  const [warmResult, setWarmResult] = useState<string | null>(null);
  const [warmStatus, setWarmStatus] = useState<Record<string, SnapshotWarmStatus>>({});
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => status?.snapshots ?? [], [status?.snapshots]);
  const seedQueue = status?.seedQueue?.length ? status.seedQueue : buildSeedQueue(rows);
  const readiness = status?.summary?.replayReadiness ?? null;
  const activeGroup = useMemo(() => {
    if (!requestedGroup) return null;
    return rows.some((row) => row.group === requestedGroup) ? requestedGroup : null;
  }, [requestedGroup, rows]);
  const visibleRows = useMemo(() => activeGroup ? rows.filter((row) => row.group === activeGroup) : rows, [activeGroup, rows]);
  const visibleSeedQueue = useMemo(() => activeGroup ? seedQueue.filter((row) => row.group === activeGroup) : seedQueue, [activeGroup, seedQueue]);
  const warmableSeedQueue = useMemo(
    () => visibleSeedQueue.filter((row) => row.canSeedNow !== false && Boolean(SNAPSHOT_WARMERS[row.key])),
    [visibleSeedQueue]
  );
  const selectedRow = (activeGroup ? visibleRows.find((row) => row.key === selectedKey) : rows.find((row) => row.key === selectedKey)) ?? visibleRows[0] ?? rows[0] ?? null;
  const tablePreview = useMemo(() => extractTablePreview(detail?.data), [detail?.data]);
  const rawPreview = useMemo(() => {
    if (detail?.data == null) return "";
    const raw = JSON.stringify(detail.data, null, 2);
    return raw.length > JSON_LIMIT ? `${raw.slice(0, JSON_LIMIT)}\n...truncated for screen preview` : raw;
  }, [detail?.data]);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError(null);
    try {
      const response = await fetchAPI<SnapshotStatusResponse>("/api/snapshots/status");
      const snapshotRows = response.snapshots ?? [];
      setStatus(response);
      const groupRows = requestedGroup ? snapshotRows.filter((row) => row.group === requestedGroup) : snapshotRows;
      const nextKey = requestedKey || (requestedGroup ? null : selectedKey) || groupRows.find((row) => row.available)?.key || groupRows[0]?.key || snapshotRows.find((row) => row.available)?.key || snapshotRows[0]?.key || null;
      setSelectedKey(nextKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load snapshot status");
    } finally {
      setLoadingStatus(false);
    }
  }, [requestedGroup, requestedKey, selectedKey]);

  const loadDetail = useCallback(async (key: string) => {
    setLoadingDetail(true);
    setError(null);
    try {
      const response = await fetchAPI<SnapshotDetailResponse>(`/api/snapshots/${encodeURIComponent(key)}`);
      setDetail(response);
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : "No payload is available for this snapshot");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (requestedKey && requestedKey !== selectedKey) {
      setSelectedKey(requestedKey);
    }
  }, [requestedKey, selectedKey]);

  useEffect(() => {
    if (!selectedKey) return;
    loadDetail(selectedKey);
  }, [loadDetail, selectedKey]);

  function selectSnapshot(key: string) {
    setSelectedKey(key);
    const row = rows.find((item) => item.key === key);
    const group = activeGroup || row?.group;
    router.replace(`/snapshots?key=${encodeURIComponent(key)}${group ? `&group=${encodeURIComponent(group)}` : ""}`);
  }

  function selectGroup(group: string | null) {
    const nextRows = group ? rows.filter((row) => row.group === group) : rows;
    const nextKey = nextRows.find((row) => row.available)?.key || nextRows[0]?.key || null;
    setSelectedKey(nextKey);
    router.replace(group ? `/snapshots?group=${encodeURIComponent(group)}${nextKey ? `&key=${encodeURIComponent(nextKey)}` : ""}` : "/snapshots");
  }

  async function refreshAll() {
    await loadStatus();
    if (selectedKey) await loadDetail(selectedKey);
  }

  async function warmSnapshot(row: SnapshotRow | SnapshotSeedQueueItem) {
    const warmer = SNAPSHOT_WARMERS[row.key];
    if (!warmer) return;

    setWarmingKey(row.key);
    setWarmResult(null);
    setError(null);
    setWarmStatus((prev) => ({ ...prev, [row.key]: { state: "running", message: "Warming" } }));
    try {
      const response = await warmSnapshotKeys([row.key]);
      const result = response.results[0];
      if (!result || result.status !== "WARMED") {
        throw new Error(result?.message || `Could not warm ${row.label}`);
      }
      setSelectedKey(row.key);
      if (response.snapshotStatus) setStatus(response.snapshotStatus);
      else await loadStatus();
      await loadDetail(row.key);
      const group = activeGroup || row.group;
      router.replace(`/snapshots?key=${encodeURIComponent(row.key)}${group ? `&group=${encodeURIComponent(group)}` : ""}`);
      setWarmStatus((prev) => ({ ...prev, [row.key]: { state: "success", message: result.message || "Completed" } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : `Could not warm ${row.label}`;
      setWarmStatus((prev) => ({ ...prev, [row.key]: { state: "error", message } }));
      setError(message);
    } finally {
      setWarmingKey(null);
    }
  }

  async function warmNextFeeds() {
    const targets = warmableSeedQueue.slice(0, 3);
    if (!targets.length) return;

    setBulkWarming(true);
    setWarmResult(null);
    setError(null);

    let warmed = 0;
    const failures: string[] = [];
    let refreshedFromResponse = false;
    for (const row of targets) {
      setWarmingKey(row.key);
      setWarmStatus((prev) => ({ ...prev, [row.key]: { state: "running", message: "Warming" } }));
    }

    try {
      const response = await warmSnapshotKeys(targets.map((row) => row.key));
      for (const result of response.results) {
        const ok = result.status === "WARMED";
        if (ok) warmed += 1;
        else failures.push(`${result.label}: ${result.message}`);
        setWarmStatus((prev) => ({
          ...prev,
          [result.key]: {
            state: ok ? "success" : "error",
            message: result.message,
          },
        }));
      }
      if (response.snapshotStatus) {
        setStatus(response.snapshotStatus);
        refreshedFromResponse = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Snapshot warm request failed.";
      failures.push(message);
      for (const row of targets) {
        setWarmStatus((prev) => ({ ...prev, [row.key]: { state: "error", message } }));
      }
    } finally {
      setWarmingKey(null);
      setBulkWarming(false);
    }

    setWarmResult(`${warmed}/${targets.length} feeds warmed${failures.length ? `, ${failures.length} failed` : ""}.`);
    if (failures.length) {
      setError(failures.slice(0, 2).join(" | "));
    }
    if (!refreshedFromResponse) {
      try {
        await loadStatus();
      } catch {}
    }
    if (selectedKey) await loadDetail(selectedKey);
  }

  return (
    <div className="max-w-[1500px] mx-auto space-y-5">
      <PageHeader eyebrow="Review & reliability" title="Snapshot replay" description="Inspect saved market data, check its age, and revisit a previous session." actions={
        <button
          type="button"
          onClick={refreshAll}
          disabled={loadingStatus || loadingDetail}
          className="inline-flex items-center gap-2 rounded border border-card-border bg-card px-3 py-2 text-sm font-semibold text-accent hover:border-accent/50 disabled:opacity-60"
        >
          <RefreshCw className={cn("h-4 w-4", (loadingStatus || loadingDetail) && "animate-spin")} />
          Refresh
        </button>
      } />

      <details className="bg-card border border-card-border rounded-xl overflow-hidden"><summary className="cursor-pointer p-4 text-sm font-semibold text-text-heading">Feed maintenance · {visibleSeedQueue.length} need attention</summary>
        <div className="px-4 py-3 border-b border-card-border flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-text-heading">Seed Queue</div>
            <div className="text-xs text-muted">
              Missing and stale feeds ranked by what should be warmed first for replay reliability.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">
              {visibleSeedQueue.length} needs attention{activeGroup ? ` in ${activeGroup}` : ""}
              {warmableSeedQueue.length ? ` / ${warmableSeedQueue.length} direct` : ""}
            </span>
            {warmableSeedQueue.length > 0 && (
              <button
                type="button"
                onClick={warmNextFeeds}
                disabled={warmingKey !== null || bulkWarming}
                className="inline-flex items-center justify-center rounded border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-semibold text-warning hover:border-warning/60 disabled:opacity-60"
              >
                {bulkWarming ? "Warming..." : `Warm next ${Math.min(3, warmableSeedQueue.length)}`}
              </button>
            )}
          </div>
        </div>
        {warmResult && (
          <div className="border-b border-card-border/40 px-4 py-2 text-xs font-semibold text-profit">
            {warmResult}
          </div>
        )}
        {visibleSeedQueue.length > 0 ? (
          <div className="divide-y divide-card-border/40">
            {visibleSeedQueue.slice(0, 8).map((row) => {
              const tone = statusTone(row.status);
              const warmer = SNAPSHOT_WARMERS[row.key];
              const rowWarmStatus = warmStatus[row.key];
              return (
                <div key={`queue-${row.key}`} className="grid grid-cols-1 lg:grid-cols-[180px_1fr_auto] gap-3 px-4 py-3 items-center">
                  <button type="button" onClick={() => selectSnapshot(row.key)} className="text-left min-w-0">
                    <div className="text-sm font-semibold text-text-heading truncate">{row.label}</div>
                    <div className={cn("text-xs font-semibold", toneText(tone))}>{statusLabel(row.status)} / {row.ageLabel || "-"}</div>
                  </button>
                  <div className="min-w-0">
                    <div className="text-xs text-muted truncate">{row.reason || row.source?.hint || "No warm-up hint configured."}</div>
                    <div className="mt-1 font-mono text-[11px] text-muted truncate">
                      {row.source?.method || "-"} {row.source?.endpoint || "-"}
                    </div>
                    {row.blockedBy?.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.blockedBy.map((blocker) => (
                          <span key={blocker} className="rounded bg-[rgba(255,193,7,0.1)] px-2 py-0.5 text-[10px] font-semibold text-warning">
                            {blockerLabel(blocker)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-1 text-[10px] font-semibold text-profit">
                        Can seed now
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-start lg:justify-end gap-2">
                    {rowWarmStatus && (
                      <span
                        className={cn("rounded px-2 py-1 text-[10px] font-semibold", warmStatusClass(rowWarmStatus.state))}
                        title={rowWarmStatus.message}
                      >
                        {rowWarmStatus.state === "running" ? "Running" : rowWarmStatus.state === "success" ? "Done" : "Failed"}
                      </span>
                    )}
                    {warmer && (
                      <button
                        type="button"
                        onClick={() => warmSnapshot(row)}
                        disabled={warmingKey !== null || row.canSeedNow === false}
                        className="inline-flex items-center justify-center rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-semibold text-warning hover:border-warning/60 disabled:opacity-60"
                      >
                        {warmingKey === row.key ? "Warming..." : warmer.label}
                      </button>
                    )}
                    {row.source?.page ? (
                      <Link
                        href={row.source.page}
                        className="inline-flex items-center justify-center rounded border border-card-border bg-page-bg px-3 py-2 text-xs font-semibold text-accent hover:border-accent/50"
                      >
                        Open source
                      </Link>
                    ) : (
                      <span className="text-xs text-muted">No source page</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-6 text-sm text-muted">All tracked feeds{activeGroup ? ` in ${activeGroup}` : ""} are fresh enough for replay.</div>
        )}
      </details>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4">
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          <div className="p-4 border-b border-card-border">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-heading">
              <Database className="h-4 w-4 text-accent" />
              Saved Feeds{activeGroup ? ` / ${activeGroup}` : ""}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <MiniMetric
                label="Replay"
                value={readiness ? `${readiness.score}%` : "-"}
                tone={readiness ? readinessTone(readiness.score) : "neutral"}
              />
              <MiniMetric label="Tracked" value={status?.summary?.tracked ?? 0} />
              <MiniMetric label="Available" value={status?.summary?.available ?? 0} tone="profit" />
              <MiniMetric label="Missing" value={status?.summary?.missing ?? 0} tone="loss" />
            </div>
            {readiness?.action && (
              <div className="mt-2 text-[11px] text-muted">
                {readiness.label}: {readiness.action}
              </div>
            )}
            {readiness?.byGroup?.length ? (
              <div className="mt-3 space-y-2">
                {readiness.byGroup.map((group) => (
                  <ReadinessGroupRow
                    key={group.group}
                    group={group}
                    active={group.group === activeGroup}
                    onSelect={() => selectGroup(group.group)}
                  />
                ))}
                {activeGroup && (
                  <button
                    type="button"
                    onClick={() => selectGroup(null)}
                    className="text-left text-[11px] font-semibold text-accent hover:underline"
                  >
                    Show all groups
                  </button>
                )}
              </div>
            ) : null}
          </div>

          <div className="max-h-[70vh] overflow-auto">
            {visibleRows.map((row) => {
              const tone = statusTone(row.status);
              const active = row.key === selectedRow?.key;
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => selectSnapshot(row.key)}
                  className={cn(
                    "w-full text-left px-4 py-3 border-b border-card-border/40 hover:bg-hover-bg transition-colors",
                    active && "bg-accent-bg/40"
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-text-heading truncate">{row.label}</div>
                      <div className="text-xs text-muted">{row.group}</div>
                    </div>
                    <span className={cn("text-xs font-semibold tabular-nums", toneText(tone))}>{row.ageLabel || row.status}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className={cn("inline-flex items-center gap-1", toneText(tone))}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", toneDot(tone))} />
                      {statusLabel(row.status)}
                    </span>
                    <span className="text-muted">{formatBytes(row.bytes)}</span>
                  </div>
                </button>
              );
            })}
            {!loadingStatus && visibleRows.length === 0 && (
              <div className="p-6 text-sm text-muted">No snapshot keys are configured.</div>
            )}
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          {selectedRow && (
            <div className="bg-card border border-card-border rounded-lg p-4">
              <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg font-semibold text-text-heading">{selectedRow.label}</h2>
                    <span className={cn("rounded px-2 py-0.5 text-xs font-semibold", badgeClass(selectedRow.status))}>
                      {statusLabel(selectedRow.status)}
                    </span>
                  </div>
                  <div className="text-sm text-muted mt-1">
                    {selectedRow.timestamp ? `Saved ${new Date(selectedRow.timestamp).toLocaleString("en-IN")}` : "No saved timestamp"}
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs min-w-full xl:min-w-[520px]">
                  <MiniMetric label="Age" value={selectedRow.ageLabel || "-"} tone={statusTone(selectedRow.status)} />
                  <MiniMetric label="Group" value={selectedRow.group} />
                  <MiniMetric label="Size" value={formatBytes(selectedRow.bytes)} />
                  <MiniMetric label="File" value={selectedRow.path || "-"} />
                </div>
              </div>
            </div>
          )}

          {selectedRow?.source && (
            <div className="bg-card border border-card-border rounded-lg p-4">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-heading">Warm-Up Source</div>
                  <div className="text-xs text-muted mt-1">{selectedRow.source.hint || "No warm-up hint is configured."}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {selectedRow && warmStatus[selectedRow.key] && (
                    <span
                      className={cn("rounded px-2 py-1 text-[10px] font-semibold", warmStatusClass(warmStatus[selectedRow.key].state))}
                      title={warmStatus[selectedRow.key].message}
                    >
                      {warmStatus[selectedRow.key].state === "running" ? "Running" : warmStatus[selectedRow.key].state === "success" ? "Done" : "Failed"}
                    </span>
                  )}
                  {SNAPSHOT_WARMERS[selectedRow.key] && (
                    <button
                      type="button"
                      onClick={() => warmSnapshot(selectedRow)}
                      disabled={warmingKey !== null}
                      className="inline-flex items-center justify-center rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-semibold text-warning hover:border-warning/60 disabled:opacity-60"
                    >
                      {warmingKey === selectedRow.key ? "Warming..." : SNAPSHOT_WARMERS[selectedRow.key].label}
                    </button>
                  )}
                  {selectedRow.source.page && (
                    <Link
                      href={selectedRow.source.page}
                      className="inline-flex items-center justify-center rounded border border-card-border bg-page-bg px-3 py-2 text-xs font-semibold text-accent hover:border-accent/50"
                    >
                      Open source page
                    </Link>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                {selectedRow.source.method && selectedRow.source.endpoint && (
                  <span className="rounded bg-page-bg border border-card-border px-2 py-1 font-mono text-muted">
                    {selectedRow.source.method} {selectedRow.source.endpoint}
                  </span>
                )}
                {selectedRow.source.requiresPremium && (
                  <span className="rounded bg-[rgba(255,193,7,0.1)] px-2 py-1 font-semibold text-warning">Premium</span>
                )}
                {selectedRow.source.requiresBroker && (
                  <span className="rounded bg-accent-bg px-2 py-1 font-semibold text-accent">Broker session</span>
                )}
                {!selectedRow.source.requiresBroker && (
                  <span className="rounded bg-surface-hover px-2 py-1 font-semibold text-muted">No broker fetch</span>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="bg-loss-bg border border-loss/20 rounded-lg p-4 text-sm text-loss flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loadingDetail && (
            <div className="h-[320px] bg-card border border-card-border rounded-lg animate-pulse flex items-center justify-center">
              <span className="text-muted">Loading snapshot payload...</span>
            </div>
          )}

          {!loadingDetail && detail?.data != null && (
            <>
              <div className="bg-card border border-card-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-card-border flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-text-heading">Table Preview</h3>
                    <p className="text-xs text-muted">{tablePreview ? `${tablePreview.label} / first ${Math.min(tablePreview.rows.length, PREVIEW_LIMIT)} rows` : "No tabular rows found"}</p>
                  </div>
                </div>
                {tablePreview ? (
                  <div className="max-h-[420px] overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card z-10">
                        <tr className="border-b border-card-border text-muted">
                          {tablePreview.columns.map((column) => (
                            <th key={column} className="text-left px-3 py-2 whitespace-nowrap">{column}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {tablePreview.rows.slice(0, PREVIEW_LIMIT).map((row, index) => (
                          <tr key={index} className="border-b border-card-border/30">
                            {tablePreview.columns.map((column) => (
                              <td key={column} className="px-3 py-2 whitespace-nowrap max-w-[220px] truncate" title={formatCell(row[column])}>
                                {formatCell(row[column])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-6 text-sm text-muted">This payload is object-shaped; use the raw preview below.</div>
                )}
              </div>

              <div className="bg-card border border-card-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-card-border">
                  <h3 className="text-sm font-semibold text-text-heading">Raw Payload Preview</h3>
                </div>
                <pre className="max-h-[520px] overflow-auto p-4 text-[11px] leading-relaxed text-muted font-mono whitespace-pre-wrap">
                  {rawPreview}
                </pre>
              </div>
            </>
          )}

          {!loadingDetail && !detail?.data && !error && (
            <div className="bg-card border border-card-border rounded-lg p-8 text-center text-sm text-muted">
              Select a saved feed to inspect its replay payload.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

async function warmSnapshotKeys(keys: string[]) {
  return postAPI<SnapshotWarmResponse>("/api/snapshots/warm", {
    keys,
    limit: keys.length,
    universe: "nifty200",
    symbolLimit: 120,
  });
}

function MiniMetric({ label, value, tone = "neutral" }: { label: string; value: string | number; tone?: Tone }) {
  return (
    <div className="bg-page-bg/60 border border-card-border rounded px-3 py-2 min-w-0">
      <div className="text-[10px] text-muted uppercase">{label}</div>
      <div className={cn("text-xs font-semibold truncate", toneText(tone))} title={String(value)}>
        {value}
      </div>
    </div>
  );
}

function ReadinessGroupRow({ group, active, onSelect }: { group: SnapshotReadinessGroup; active?: boolean; onSelect?: () => void }) {
  const tone = readinessTone(group.score);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full min-w-0 text-left rounded border border-transparent p-2 -mx-2 transition-colors hover:border-card-border hover:bg-hover-bg",
        active && "border-card-border bg-accent-bg/30"
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-semibold text-text-heading truncate" title={group.group}>{group.group}</span>
        <span className={cn("font-mono font-semibold tabular-nums", toneText(tone))}>{group.score}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded bg-surface-hover overflow-hidden">
        <div className={cn("h-full rounded", toneDot(tone))} style={{ width: `${Math.max(2, Math.min(100, group.score))}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-muted">
        {group.ready}/{group.tracked} ready{group.needsAttention ? ` / ${group.needsAttention} need warming` : ""}
      </div>
    </button>
  );
}

function buildSeedQueue(rows: SnapshotRow[]): SnapshotSeedQueueItem[] {
  return rows
    .filter((row) => row.status === "missing" || row.status === "stale")
    .slice()
    .sort((a, b) => seedRank(a) - seedRank(b))
    .map((row) => ({
      key: row.key,
      label: row.label,
      group: row.group,
      status: row.status,
      ageSeconds: row.ageSeconds,
      ageLabel: row.ageLabel,
      source: row.source,
      reason: row.status === "missing" ? "No replay snapshot exists yet." : `Last replay is stale at ${row.ageLabel || "unknown age"}.`,
      blockedBy: [],
      canSeedNow: true,
    }));
}

function seedRank(row: SnapshotRow) {
  if (row.status === "missing") return 0;
  const age = row.ageSeconds ?? 0;
  return 1_000_000 - Math.min(age, 999_999);
}

function extractTablePreview(data: unknown): { label: string; rows: Record<string, unknown>[]; columns: string[] } | null {
  const match = findArray(data);
  if (!match) return null;
  const columns = chooseColumns(match.rows);
  return { ...match, columns };
}

function findArray(data: unknown): { label: string; rows: Record<string, unknown>[] } | null {
  if (Array.isArray(data) && isObjectRowArray(data)) {
    return { label: "root", rows: data as Record<string, unknown>[] };
  }
  if (!isPlainObject(data)) return null;

  for (const key of ["candidates", "actionable", "watchlist", "results", "indices", "movers", "signals", "sectors", "data"]) {
    const value = data[key];
    if (Array.isArray(value) && isObjectRowArray(value)) {
      return { label: key, rows: value as Record<string, unknown>[] };
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && isObjectRowArray(value)) {
      return { label: key, rows: value as Record<string, unknown>[] };
    }
  }

  return null;
}

function chooseColumns(rows: Record<string, unknown>[]) {
  const keys = new Set<string>();
  for (const row of rows.slice(0, PREVIEW_LIMIT)) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  const preferred = PREFERRED_COLUMNS.filter((key) => keys.has(key));
  const rest = [...keys].filter((key) => !preferred.includes(key)).slice(0, Math.max(0, 8 - preferred.length));
  return [...preferred, ...rest].slice(0, 10);
}

function isObjectRowArray(value: unknown[]) {
  return value.some((item) => isPlainObject(item));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCell(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "-";
    return Math.abs(value) >= 1000 ? Math.round(value).toLocaleString("en-IN") : Number(value.toFixed(2)).toString();
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function formatBytes(value?: number | null) {
  if (!value) return "-";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function statusTone(status: SnapshotStatus): Tone {
  if (status === "fresh" || status === "last-session") return "profit";
  if (status === "stale") return "warning";
  if (status === "missing") return "loss";
  return "neutral";
}

function readinessTone(score: number): Tone {
  if (score >= 80) return "profit";
  if (score >= 50) return "warning";
  return "loss";
}

function statusLabel(status: SnapshotStatus) {
  if (status === "last-session") return "Last session";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function blockerLabel(blocker: string) {
  if (blocker === "broker_login") return "Broker login needed";
  return blocker.replace(/_/g, " ");
}

function badgeClass(status: SnapshotStatus) {
  const tone = statusTone(status);
  if (tone === "profit") return "bg-profit-bg text-profit";
  if (tone === "warning") return "bg-[rgba(255,193,7,0.1)] text-warning";
  if (tone === "loss") return "bg-loss-bg text-loss";
  return "bg-surface-hover text-muted";
}

function warmStatusClass(state: SnapshotWarmState) {
  if (state === "success") return "bg-profit-bg text-profit";
  if (state === "error") return "bg-loss-bg text-loss";
  return "bg-[rgba(255,193,7,0.1)] text-warning";
}

function toneText(tone: Tone) {
  if (tone === "profit") return "text-profit";
  if (tone === "warning") return "text-warning";
  if (tone === "loss") return "text-loss";
  return "text-muted";
}

function toneDot(tone: Tone) {
  if (tone === "profit") return "bg-profit";
  if (tone === "warning") return "bg-warning";
  if (tone === "loss") return "bg-loss";
  return "bg-muted";
}
