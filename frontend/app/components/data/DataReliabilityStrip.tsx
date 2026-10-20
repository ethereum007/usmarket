"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchAPI } from "../../lib/api";
import { cn } from "../../lib/utils";

interface HealthResponse {
  status?: string;
  kiteConnected?: boolean;
  authenticated?: boolean;
  timestamp?: string;
  uptime?: number;
}

interface ArrowStatusResponse {
  success?: boolean;
  configured?: boolean;
  hasToken?: boolean;
  tokenSource?: string | null;
}

interface IndicesResponse {
  indices?: unknown[];
  cached?: boolean;
  cachedAt?: string;
  timestamp?: number | string;
  warning?: string;
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

interface SnapshotRow {
  key: string;
  label: string;
  group: string;
  available: boolean;
  status: "fresh" | "last-session" | "stale" | "missing" | "unknown";
  ageSeconds?: number | null;
  ageLabel?: string | null;
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

interface SnapshotSeedQueueItem {
  key: string;
  label: string;
  group: string;
  status: SnapshotRow["status"];
  ageSeconds?: number | null;
  ageLabel?: string | null;
  priority?: number;
  reason?: string;
  blockedBy?: string[];
  canSeedNow?: boolean;
  source?: SnapshotSource | null;
}

type Tone = "profit" | "warning" | "loss" | "neutral";

const CACHE_KEY = "alpha-radar:data-reliability";
const SNAPSHOT_PRIORITY = [
  "indices",
  "intraday_radar",
  "pulse",
  "top_movers",
  "breadth",
  "abnormal_live",
  "live_signals",
  "sector_momentum",
  "quote_sectors",
  "hot_cold_indices",
  "orb_signals",
  "52w_bounce",
];

export function DataReliabilityStrip({ compact = false }: { compact?: boolean }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [arrow, setArrow] = useState<ArrowStatusResponse | null>(null);
  const [indices, setIndices] = useState<IndicesResponse | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [healthRes, arrowRes, indicesRes, snapshotsRes] = await Promise.allSettled([
          fetchAPI<HealthResponse>("/api/health"),
          fetchAPI<ArrowStatusResponse>("/api/arrow/status"),
          fetchAPI<IndicesResponse>("/api/quotes/indices"),
          fetchAPI<SnapshotStatusResponse>("/api/snapshots/status"),
        ]);

        if (cancelled) return;
        const nextHealth = healthRes.status === "fulfilled" ? healthRes.value : null;
        const nextArrow = arrowRes.status === "fulfilled" ? arrowRes.value : null;
        const nextIndices = indicesRes.status === "fulfilled" ? indicesRes.value : null;
        const nextSnapshots = snapshotsRes.status === "fulfilled" ? snapshotsRes.value : null;
        if (nextHealth) setHealth(nextHealth);
        if (nextArrow) setArrow(nextArrow);
        if (nextIndices) setIndices(nextIndices);
        if (nextSnapshots) setSnapshots(nextSnapshots);
        window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ health: nextHealth, arrow: nextArrow, indices: nextIndices, snapshots: nextSnapshots, checkedAt: Date.now() }));

        const failures = [healthRes, arrowRes, indicesRes, snapshotsRes].filter((item) => item.status === "rejected").length;
        setError(failures ? `${failures} status check${failures > 1 ? "s" : ""} failed` : null);
        setCheckedAt(Date.now());
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not verify data status");
          setCheckedAt(Date.now());
        }
      }
    }

    const cached = window.sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        setHealth(parsed.health); setArrow(parsed.arrow); setIndices(parsed.indices); setSnapshots(parsed.snapshots); setCheckedAt(parsed.checkedAt);
      } catch { void load(); }
    } else { void load(); }
    return () => {
      cancelled = true;
    };
  }, []);

  const kiteConnected = Boolean(health?.kiteConnected ?? health?.authenticated);
  const arrowReady = Boolean(arrow?.configured && arrow?.hasToken);
  const snapshotAvailable = snapshots?.summary?.available ?? 0;
  const snapshotTracked = snapshots?.summary?.tracked ?? 0;
  const freshestSnapshot = snapshots?.summary?.freshest;
  const readiness = snapshots?.summary?.replayReadiness ?? null;
  const snapshotRows = useMemo(() => snapshots?.snapshots ?? [], [snapshots?.snapshots]);
  const snapshotBreakdown = useMemo(() => {
    const counts: Record<SnapshotRow["status"], number> = {
      fresh: 0,
      "last-session": 0,
      stale: 0,
      missing: 0,
      unknown: 0,
    };

    for (const row of snapshotRows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }

    return {
      counts,
      priorityRows: [...snapshotRows].sort((left, right) => snapshotPriority(left.key) - snapshotPriority(right.key)).slice(0, 6),
    };
  }, [snapshotRows]);
  const seedQueue = snapshots?.seedQueue?.length ? snapshots.seedQueue : buildSeedQueue(snapshotRows);
  const firstSeedBlocked = seedQueue[0]?.blockedBy?.includes("broker_login");
  const sessionMode = useMemo(() => {
    if (kiteConnected || arrowReady) return "Live feed ready";
    if (indices?.indices?.length || snapshotAvailable > 0) return "Previous-session replay";
    return "Offline watch";
  }, [arrowReady, indices?.indices?.length, kiteConnected, snapshotAvailable]);

  const sessionTone: Tone = kiteConnected || arrowReady ? "profit" : indices?.indices?.length || snapshotAvailable > 0 ? "warning" : "loss";
  const updatedAt = indices?.cachedAt || health?.timestamp || (checkedAt ? new Date(checkedAt).toISOString() : null);
  const lastGoodTone: Tone =
    snapshotAvailable === 0
      ? "loss"
      : snapshotBreakdown.counts.fresh + snapshotBreakdown.counts["last-session"] === snapshotTracked
        ? "profit"
        : "warning";
  const readinessTone = readiness ? readinessToneFromScore(readiness.score) : lastGoodTone;

  return (
    <details className="data-disclosure">
      <summary>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", toneDot(sessionTone))} />
        <span className="font-medium text-text-heading">Data status</span>
        <span className="text-muted">{indices?.cached ? "Previous-session snapshot" : sessionMode}</span>
        {error && <span className="text-warning">Some checks unavailable</span>}
      </summary>
      <div className="data-disclosure-content">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("h-2 w-2 rounded-full", toneDot(sessionTone))} />
            <span className="text-sm font-semibold text-text-heading">{sessionMode}</span>
            {indices?.cached && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-warning/10 text-warning">
                cached market snapshot
              </span>
            )}
          </div>
          <div className="text-xs text-muted mt-1 truncate">
            {updatedAt ? `Last verified ${new Date(updatedAt).toLocaleString("en-IN")}` : "Verifying market-data status"}
            {error ? ` | ${error}` : ""}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 w-full xl:w-auto xl:min-w-[480px]">
          <StatusPill label="Kite" value={kiteConnected ? "Connected" : "Disconnected"} tone={kiteConnected ? "profit" : "warning"} />
          <StatusPill
            label="Arrow"
            value={arrowReady ? `Ready${arrow?.tokenSource ? ` / ${arrow.tokenSource}` : ""}` : arrow?.configured ? "Needs login" : "Not configured"}
            tone={arrowReady ? "profit" : arrow?.configured ? "warning" : "loss"}
          />
          <StatusPill
            label="Replay"
            value={readiness ? `${readiness.score}% / ${readiness.label}` : indices?.indices?.length ? `${indices.indices.length} indices` : "Unavailable"}
            tone={readinessTone}
          />
          <StatusPill
            label="Last-Good"
            value={snapshotTracked ? `${snapshotAvailable}/${snapshotTracked}${freshestSnapshot?.ageLabel ? ` / ${freshestSnapshot.ageLabel}` : ""}` : "Unknown"}
            tone={lastGoodTone}
          />
        </div>
      </div>

      {compact && seedQueue.length > 0 && (
        <div className="mt-3 pt-3 border-t border-card-border/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="text-xs text-muted">
            {readiness && <span className={cn("font-semibold", toneText(readinessTone))}>{readiness.score}% replay ready</span>}
            {readiness && " / "}
            <span className="font-semibold text-warning">{seedQueue.length} feed{seedQueue.length > 1 ? "s" : ""} need warming</span>
            {snapshotBreakdown.counts.missing > 0 ? ` / ${snapshotBreakdown.counts.missing} missing` : ""}
            {snapshotBreakdown.counts.stale > 0 ? ` / ${snapshotBreakdown.counts.stale} stale` : ""}
            {firstSeedBlocked ? " / broker login needed" : ""}
          </div>
          <Link
            href={`/snapshots?key=${encodeURIComponent(seedQueue[0].key)}`}
            className="inline-flex items-center justify-center rounded border border-card-border bg-page-bg/70 px-3 py-1.5 text-xs font-semibold text-accent hover:border-accent/50 hover:bg-accent-bg transition-colors"
          >
            Open Seed Queue
          </Link>
        </div>
      )}

      {!compact && (
        <div className="mt-3 pt-3 border-t border-card-border/60">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] text-muted uppercase">Snapshot Coverage</div>
              <div className="text-xs text-text-heading truncate">
                {readiness
                  ? `${readiness.score}% replay ready / ${readiness.action}`
                  : snapshotTracked
                  ? `${snapshotAvailable}/${snapshotTracked} feeds available for replay and freshness checks`
                  : "Awaiting snapshot status from the backend"}
              </div>
            </div>
            <Link
              href="/snapshots"
              className="inline-flex items-center justify-center rounded border border-card-border bg-page-bg/70 px-3 py-1.5 text-xs font-semibold text-accent hover:border-accent/50 hover:bg-accent-bg transition-colors"
            >
              Open Replay
            </Link>
          </div>

          <div className="mt-2 flex flex-col lg:flex-row lg:items-center justify-between gap-2">
            <div className={cn("flex flex-wrap gap-2", !snapshotTracked && "opacity-60")}>
              <SnapshotCount label="Fresh" value={snapshotBreakdown.counts.fresh} tone="profit" />
              <SnapshotCount label="Last session" value={snapshotBreakdown.counts["last-session"]} tone="profit" />
              <SnapshotCount label="Stale" value={snapshotBreakdown.counts.stale} tone="warning" />
              <SnapshotCount label="Missing" value={snapshotBreakdown.counts.missing} tone="loss" />
            </div>
          </div>

          {readiness?.byGroup?.length ? (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
              {readiness.byGroup.map((group) => (
                <ReadinessGroupPill key={group.group} group={group} />
              ))}
            </div>
          ) : null}

          {snapshotBreakdown.priorityRows.length > 0 && (
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1">
              {snapshotBreakdown.priorityRows.map((row) => (
                <SnapshotMiniRow key={row.key} row={row} />
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </details>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="bg-page-bg/60 border border-card-border rounded px-3 py-2 min-w-0">
      <div className="text-[10px] text-muted uppercase">{label}</div>
      <div className={cn("text-xs font-semibold truncate", toneText(tone))} title={value}>
        {value}
      </div>
    </div>
  );
}

function ReadinessGroupPill({ group }: { group: SnapshotReadinessGroup }) {
  const tone = readinessToneFromScore(group.score);
  return (
    <Link
      href={`/snapshots?group=${encodeURIComponent(group.group)}`}
      className="rounded border border-card-border bg-page-bg/50 px-3 py-2 min-w-0 transition-colors hover:border-accent/50 hover:bg-accent-bg/30"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-text-heading truncate" title={group.group}>{group.group}</span>
        <span className={cn("font-mono font-semibold tabular-nums", toneText(tone))}>{group.score}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded bg-surface-hover overflow-hidden">
        <div className={cn("h-full rounded", toneDot(tone))} style={{ width: `${Math.max(2, Math.min(100, group.score))}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-muted">
        {group.ready}/{group.tracked} ready{group.needsAttention ? ` / ${group.needsAttention} warm` : ""}
      </div>
    </Link>
  );
}

function SnapshotCount({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={cn("h-1.5 w-1.5 rounded-full", toneDot(tone))} />
      <span className="text-muted">{label}</span>
      <span className={cn("font-semibold", toneText(tone))}>{value}</span>
    </div>
  );
}

function SnapshotMiniRow({ row }: { row: SnapshotRow }) {
  const tone = snapshotStatusTone(row.status);
  return (
    <Link href={`/snapshots?key=${encodeURIComponent(row.key)}`} className="min-w-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs hover:text-accent">
      <div className="min-w-0 flex items-center gap-2">
        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", toneDot(tone))} />
        <span className="truncate text-text-heading" title={`${row.label} / ${row.group}`}>
          {row.label}
        </span>
      </div>
      <span className={cn("font-medium tabular-nums", toneText(tone))} title={row.ageLabel ?? snapshotStatusLabel(row.status)}>
        {row.ageLabel || snapshotStatusLabel(row.status)}
      </span>
    </Link>
  );
}

function snapshotPriority(key: string) {
  const index = SNAPSHOT_PRIORITY.indexOf(key);
  return index === -1 ? SNAPSHOT_PRIORITY.length : index;
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
  return 1_000_000 - Math.min(row.ageSeconds ?? 0, 999_999);
}

function snapshotStatusTone(status: SnapshotRow["status"]): Tone {
  if (status === "fresh" || status === "last-session") return "profit";
  if (status === "stale") return "warning";
  if (status === "missing") return "loss";
  return "neutral";
}

function snapshotStatusLabel(status: SnapshotRow["status"]) {
  if (status === "last-session") return "Last";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function readinessToneFromScore(score: number): Tone {
  if (score >= 80) return "profit";
  if (score >= 50) return "warning";
  return "loss";
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
