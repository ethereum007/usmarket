"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteAPI, fetchAPI, postAPI } from "../../lib/api";
import { cn } from "../../lib/utils";

const ALERT_RULES_KEY = "alpha-radar:alert-rules";

type Bias = "LONG" | "SHORT" | "NEUTRAL";
type RuleSource = "server" | "local";

interface AlertRule {
  id: string;
  symbol: string;
  bias: Bias;
  entry: number;
  stop?: number | null;
  target1?: number | null;
  minScore?: number;
  maxSpreadPct?: number;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  enabled?: boolean;
  userEmail?: string | null;
}

interface AlertRulesResponse {
  success: boolean;
  count: number;
  rules: AlertRule[];
}

interface AlertEvaluation {
  id: string;
  symbol: string;
  source?: string;
  bias: Bias;
  status: "TRIGGERED" | "NEAR" | "WAIT" | "TARGET_HIT" | "INVALIDATED" | "NO_QUOTE" | "INVALID_RULE";
  actionable: boolean;
  message: string;
  ltp?: number;
  entry: number;
  distancePct?: number;
  distanceToEntryPct?: number;
  spreadPct?: number | null;
  spreadOk?: boolean;
  quoteSource?: string;
}

interface AlertEvaluateResponse {
  success: boolean;
  timestamp?: number | null;
  updatedAt?: string | null;
  provider?: {
    provider?: string;
    returned?: number;
    requested?: number;
    elapsedMs?: number;
    fallback?: boolean;
    fallbackReason?: string;
  };
  summary: {
    total: number;
    triggered: number;
    near: number;
    invalidated: number;
    noQuote: number;
  };
  evaluations: AlertEvaluation[];
}

interface DisplayRule extends AlertRule {
  storage: RuleSource;
}

export default function AlertsContent() {
  const [serverRules, setServerRules] = useState<AlertRule[]>([]);
  const [localRules, setLocalRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [evaluating, setEvaluating] = useState(false);
  const [evaluations, setEvaluations] = useState<AlertEvaluation[]>([]);
  const [evaluationMeta, setEvaluationMeta] = useState<AlertEvaluateResponse | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const loadLocalRules = useCallback(() => {
    try {
      const raw = window.localStorage.getItem(ALERT_RULES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      setLocalRules(Array.isArray(parsed) ? parsed.filter(isRuleLike).map(normalizeLocalRule) : []);
    } catch {
      setLocalRules([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    loadLocalRules();
    try {
      const [rulesRes, evalRes] = await Promise.allSettled([
        fetchAPI<AlertRulesResponse>("/api/alerts/rules"),
        fetchAPI<AlertEvaluateResponse>("/api/alerts/evaluations"),
      ]);
      if (rulesRes.status === "fulfilled") {
        setServerRules(Array.isArray(rulesRes.value.rules) ? rulesRes.value.rules : []);
      } else {
        setServerRules([]);
        setError(rulesRes.reason instanceof Error ? rulesRes.reason.message : "Could not load server alert rules.");
      }
      if (evalRes.status === "fulfilled") {
        setEvaluationMeta(evalRes.value);
        setEvaluations(Array.isArray(evalRes.value.evaluations) ? evalRes.value.evaluations : []);
      }
    } catch (err) {
      setServerRules([]);
      setError(err instanceof Error ? err.message : "Could not load server alert rules.");
    } finally {
      setLoading(false);
    }
  }, [loadLocalRules]);

  useEffect(() => {
    load();
  }, [load]);

  const rules = useMemo(() => {
    const merged = new Map<string, DisplayRule>();
    localRules.forEach((rule) => merged.set(ruleKey(rule), { ...rule, storage: "local" }));
    serverRules.forEach((rule) => merged.set(ruleKey(rule), { ...rule, storage: "server" }));
    return Array.from(merged.values()).sort((a, b) => timeValue(b) - timeValue(a));
  }, [localRules, serverRules]);

  const summary = useMemo(() => {
    const long = rules.filter((rule) => rule.bias === "LONG").length;
    const short = rules.filter((rule) => rule.bias === "SHORT").length;
    const server = rules.filter((rule) => rule.storage === "server").length;
    return { total: rules.length, long, short, server, local: rules.length - server };
  }, [rules]);

  const evaluationMap = useMemo(() => {
    const map = new Map<string, AlertEvaluation>();
    evaluations.forEach((item) => map.set(ruleKey(item), item));
    return map;
  }, [evaluations]);

  const liveSummary = evaluationMeta?.summary;

  async function evaluateRules() {
    setEvaluating(true);
    setEvalError(null);
    try {
      const res = await postAPI<AlertEvaluateResponse>("/api/alerts/evaluate", {
        quoteProvider: "arrow_first",
        maxNearPct: 0.5,
      });
      setEvaluationMeta(res);
      setEvaluations(Array.isArray(res.evaluations) ? res.evaluations : []);
    } catch (err) {
      setEvaluationMeta(null);
      setEvaluations([]);
      setEvalError(err instanceof Error ? err.message : "Could not evaluate alert rules.");
    } finally {
      setEvaluating(false);
    }
  }

  async function removeRule(rule: DisplayRule) {
    setSavingId(rule.id);
    setError(null);
    try {
      if (rule.storage === "server") {
        await deleteAPI(`/api/alerts/rules/${encodeURIComponent(rule.id)}`);
        setServerRules((prev) => prev.filter((item) => item.id !== rule.id));
      }
      removeLocalRule(rule);
      loadLocalRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove alert rule.");
    } finally {
      setSavingId(null);
    }
  }

  function removeLocalRule(rule: AlertRule) {
    try {
      const raw = window.localStorage.getItem(ALERT_RULES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return;
      const next = parsed.filter((item) => {
        const candidate = normalizeLocalRule(item);
        return ruleKey(candidate) !== ruleKey(rule);
      });
      window.localStorage.setItem(ALERT_RULES_KEY, JSON.stringify(next));
    } catch {
      // Best effort only. Server state remains the source of truth when synced.
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-card border border-card-border rounded-lg p-4">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">Saved Alerts</div>
            <h2 className="text-lg font-semibold text-text-heading mt-1">Cockpit rules waiting for clean execution</h2>
            <p className="text-xs text-muted mt-1 max-w-3xl">
              Review triggers saved from the trade decision page. Server rules follow your account; local rules stay on this browser.
            </p>
          </div>
          <div className="flex gap-2 self-start lg:self-auto">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="px-3 py-2 rounded border border-card-border text-xs text-foreground hover:bg-hover-bg disabled:opacity-50"
            >
              {loading ? "Loading" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={evaluateRules}
              disabled={evaluating || summary.server === 0}
              className="px-3 py-2 rounded bg-accent text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50"
            >
              {evaluating ? "Checking" : "Check now"}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-warning/10 border border-warning/20 rounded p-3 text-warning text-sm">
          {error} Local alerts are still shown when available.
        </div>
      )}

      {evalError && (
        <div className="bg-warning/10 border border-warning/20 rounded p-3 text-warning text-sm">
          {evalError}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-7 gap-3">
        <Summary label="Total Rules" value={summary.total} />
        <Summary label="Long" value={summary.long} tone="profit" />
        <Summary label="Short" value={summary.short} tone="loss" />
        <Summary label="Server" value={summary.server} tone="profit" />
        <Summary label="Local" value={summary.local} tone="warning" />
        <Summary label="Triggered" value={liveSummary ? liveSummary.triggered : "-"} tone="profit" />
        <Summary label="Near" value={liveSummary ? liveSummary.near : "-"} tone="warning" />
      </div>

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text-heading">Alert Queue</div>
            <div className="text-xs text-muted">
              {rules.length ? `${rules.length} saved trigger${rules.length === 1 ? "" : "s"}` : "No saved triggers yet"}
              {evaluationMeta?.provider ? ` | ${evaluationMeta.provider.provider || "quotes"} ${evaluationMeta.provider.returned ?? 0}/${evaluationMeta.provider.requested ?? 0}` : ""}
              {evaluationMeta?.provider?.elapsedMs ? ` in ${Math.round(evaluationMeta.provider.elapsedMs)} ms` : ""}
              {evaluationMeta?.updatedAt ? ` | checked ${formatTime(evaluationMeta.updatedAt)}` : ""}
            </div>
          </div>
          {evaluationMeta?.provider?.fallbackReason && (
            <div className="text-xs text-warning max-w-md truncate" title={evaluationMeta.provider.fallbackReason}>
              {evaluationMeta.provider.fallbackReason}
            </div>
          )}
        </div>

        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-card-border text-muted">
                <th className="text-left px-4 py-2">Symbol</th>
                <th className="text-left px-2 py-2">Side</th>
                <th className="text-right px-2 py-2">Entry</th>
                <th className="text-right px-2 py-2">Stop</th>
                <th className="text-right px-2 py-2">Target</th>
                <th className="text-right px-2 py-2">Quality</th>
                <th className="text-right px-2 py-2">Spread</th>
                <th className="text-right px-2 py-2">Live</th>
                <th className="text-left px-2 py-2">State</th>
                <th className="text-left px-2 py-2">Saved</th>
                <th className="text-right px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rules.map((rule) => {
                const evaluation = evaluationMap.get(ruleKey(rule));
                return (
                  <tr key={`${rule.storage}-${rule.id}`} className="border-b border-card-border/30 hover:bg-hover-bg">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-accent">{rule.symbol}</span>
                        <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", rule.storage === "server" ? "bg-profit-bg text-profit" : "bg-card-border/50 text-muted")}>
                          {rule.storage === "server" ? "SERVER" : "LOCAL"}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <span className={cn("px-2 py-0.5 rounded text-[10px] font-semibold", rule.bias === "LONG" ? "bg-profit-bg text-profit" : rule.bias === "SHORT" ? "bg-loss-bg text-loss" : "bg-card-border/40 text-muted")}>
                        {rule.bias}
                      </span>
                    </td>
                    <td className="text-right px-2 py-2">{fmtPrice(rule.entry)}</td>
                    <td className="text-right px-2 py-2 text-loss">{fmtPrice(rule.stop)}</td>
                    <td className="text-right px-2 py-2 text-profit">{fmtPrice(rule.target1)}</td>
                    <td className="text-right px-2 py-2">Score &gt;= {rule.minScore ?? 70}</td>
                    <td className="text-right px-2 py-2">{rule.maxSpreadPct == null ? "-" : `${rule.maxSpreadPct}%`}</td>
                    <td className="text-right px-2 py-2">
                      <EvaluationPrice evaluation={evaluation} />
                    </td>
                    <td className="px-2 py-2">
                      <EvaluationStatus evaluation={evaluation} storage={rule.storage} />
                    </td>
                    <td className="px-2 py-2 text-muted">{formatTime(rule.updatedAt || rule.createdAt)}</td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/radar-trade?symbol=${encodeURIComponent(rule.symbol)}`}
                          className="px-2 py-1 rounded border border-card-border text-foreground hover:bg-hover-bg"
                        >
                          Open
                        </Link>
                        <button
                          type="button"
                          onClick={() => removeRule(rule)}
                          disabled={savingId === rule.id}
                          className="px-2 py-1 rounded border border-loss/30 text-loss hover:bg-loss-bg disabled:opacity-50"
                        >
                          {savingId === rule.id ? "..." : "Remove"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && rules.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-muted">
                    No saved alert rules yet. Open a trade decision page and save a cockpit trigger when the setup has a valid entry.
                  </td>
                </tr>
              )}
              {loading && rules.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-muted">Loading saved alert rules...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EvaluationPrice({ evaluation }: { evaluation?: AlertEvaluation }) {
  if (!evaluation) {
    return <span className="text-muted">-</span>;
  }
  return (
    <div>
      <div className="text-foreground">{fmtPrice(evaluation.ltp)}</div>
      <div className={cn("text-[10px]", (evaluation.distancePct ?? 0) >= 0 ? "text-profit" : "text-muted")}>
        {fmtSignedPct(evaluation.distancePct)}
      </div>
    </div>
  );
}

function EvaluationStatus({ evaluation, storage }: { evaluation?: AlertEvaluation; storage: RuleSource }) {
  if (storage !== "server") {
    return <span className="text-muted text-[11px]">Server only</span>;
  }
  if (!evaluation) {
    return <span className="text-muted text-[11px]">Not checked</span>;
  }
  return (
    <div className="space-y-1 min-w-[120px]" title={evaluation.message}>
      <span className={cn("inline-flex px-2 py-0.5 rounded text-[10px] font-semibold", statusClass(evaluation.status, evaluation.actionable))}>
        {statusLabel(evaluation.status, evaluation.actionable)}
      </span>
      <div className={cn("text-[10px]", evaluation.spreadOk === false ? "text-warning" : "text-muted")}>
        {evaluation.spreadPct == null ? evaluation.quoteSource || "-" : `${evaluation.spreadPct.toFixed(2)}% spread`}
      </div>
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: number | string; tone?: "profit" | "warning" | "loss" }) {
  return (
    <div className="bg-card border border-card-border rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("text-2xl font-bold mt-1", tone === "profit" && "text-profit", tone === "warning" && "text-warning", tone === "loss" && "text-loss")}>{value}</div>
    </div>
  );
}

function statusLabel(status: AlertEvaluation["status"], actionable: boolean) {
  if (status === "TRIGGERED" && actionable) return "ACTION";
  if (status === "TRIGGERED") return "WIDE";
  if (status === "TARGET_HIT") return "TARGET";
  if (status === "NO_QUOTE") return "NO QUOTE";
  if (status === "INVALID_RULE") return "BAD RULE";
  return status;
}

function statusClass(status: AlertEvaluation["status"], actionable: boolean) {
  if (status === "TRIGGERED" && actionable) return "bg-profit-bg text-profit";
  if (status === "TRIGGERED" || status === "NEAR") return "bg-warning/10 text-warning";
  if (status === "INVALIDATED" || status === "INVALID_RULE" || status === "NO_QUOTE") return "bg-loss-bg text-loss";
  if (status === "TARGET_HIT") return "bg-accent-bg text-accent";
  return "bg-card-border/50 text-muted";
}

function isRuleLike(value: unknown): value is Partial<AlertRule> {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AlertRule>;
  return typeof item.symbol === "string" && typeof item.entry === "number";
}

function normalizeLocalRule(value: Partial<AlertRule>): AlertRule {
  const symbol = String(value.symbol || "").toUpperCase().replace("NSE:", "").replace("BSE:", "");
  return {
    id: value.id || `local:${symbol}:${value.source || "decision-cockpit"}`,
    symbol,
    bias: value.bias === "SHORT" ? "SHORT" : value.bias === "NEUTRAL" ? "NEUTRAL" : "LONG",
    entry: Number(value.entry || 0),
    stop: value.stop == null ? null : Number(value.stop),
    target1: value.target1 == null ? null : Number(value.target1),
    minScore: value.minScore == null ? 70 : Number(value.minScore),
    maxSpreadPct: value.maxSpreadPct == null ? 0.12 : Number(value.maxSpreadPct),
    source: value.source || "decision-cockpit",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    enabled: value.enabled ?? true,
  };
}

function ruleKey(rule: AlertRule) {
  return `${rule.source || "decision-cockpit"}:${rule.symbol}`;
}

function timeValue(rule: AlertRule) {
  const raw = rule.updatedAt || rule.createdAt;
  return raw ? Date.parse(raw) || 0 : 0;
}

function fmtPrice(value?: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "-";
  return value.toFixed(2);
}

function fmtSignedPct(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatTime(raw?: string) {
  if (!raw) return "-";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
