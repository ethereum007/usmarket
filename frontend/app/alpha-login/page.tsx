"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "../contexts/AuthContext";
import Link from "next/link";
import SubscriberDashboard from "../components/admin/SubscriberDashboard";
import { PageHeader } from "../components/layout/PageHeader";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const ADMIN_EMAILS = ["charan@trezofin.ai", "balaji.kdutta@gmail.com"];

interface AuthStatus {
  authenticated: boolean;
  loginUrl?: string;
  avgVolumeCacheSize?: number;
  pdhCacheSize?: number;
}

interface ArrowStatus {
  loginUrl?: string;
  configured: boolean;
  hasAccessToken?: boolean;
  tokenSource?: string | null;
  tokenFresh?: boolean | null;
  tokenExpiresAt?: string | null;
  message?: string | null;
  autoLogin?: {
    enabled: boolean;
    configured: boolean;
    missingSettings?: string[];
    schedule?: {
      hour: number;
      minute: number;
      timezone: string;
      days: string;
    };
    lastAttemptAt?: string | null;
    lastSuccessAt?: string | null;
    lastStatus?: string | null;
    lastError?: string | null;
  };
  error?: string;
}

interface ArrowBenchmark {
  timestamp?: string;
  symbols?: string[];
  kite?: {
    elapsedMs?: number;
    requested?: number;
    returned?: number;
  };
  arrow?: {
    elapsedMs?: number;
    requested?: number;
    returned?: number;
    source?: string;
    mode?: string;
  };
  sample?: {
    kite?: Record<string, unknown> | null;
    arrow?: Record<string, unknown> | null;
  };
}

interface Coupon {
  id: string;
  code: string;
  label?: string;
  duration_days: number;
  used_by?: string;
  used_by_email?: string;
  used_at?: string;
}

interface Feedback {
  id: string;
  user_name?: string;
  user_email?: string;
  category: string;
  message: string;
  rating?: number;
  created_at: string;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatArrowTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function useAdminRequestHeaders() {
  const { session } = useAuth();
  const accessToken = session?.access_token || "";

  return useMemo(() => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }, [accessToken]);
}

function hasAdminCredentials(headers: Record<string, string>) {
  return Boolean(headers.Authorization);
}

export default function AlphaLoginPage() {
  const { user } = useAuth();
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [arrowStatus, setArrowStatus] = useState<ArrowStatus>({ configured: false });
  const [benchmark, setBenchmark] = useState<ArrowBenchmark | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [arrowAutoLoginLoading, setArrowAutoLoginLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"subscribers" | "login" | "coupons" | "feedback">("subscribers");

  const isAdmin = user && ADMIN_EMAILS.includes(user.email?.toLowerCase() || "");
  const adminHeaders = useAdminRequestHeaders();

  const checkAuth = useCallback(async () => {
    if (!hasAdminCredentials(adminHeaders)) return;

    try {
      const r = await fetch(`${API_URL}/api/auth/status`, { headers: adminHeaders });
      const data = await r.json();
      if (!data.loginUrl) {
        try {
          const lr = await fetch(`${API_URL}/api/auth/login-url`, { headers: adminHeaders });
          const ld = await lr.json();
          data.loginUrl = ld.url;
        } catch {}
      }
      setAuthStatus(data);
    } catch {
      setError("Cannot connect to backend");
    }
  }, [adminHeaders]);

  const checkArrow = useCallback(async () => {
    if (!hasAdminCredentials(adminHeaders)) return;

    try {
      const [statusRes, loginRes] = await Promise.all([
        fetch(`${API_URL}/api/arrow/status`, { headers: adminHeaders }),
        fetch(`${API_URL}/api/arrow/login-url`, { headers: adminHeaders }),
      ]);
      const statusData = await statusRes.json();
      const loginData = await loginRes.json();
      if (!loginRes.ok || !loginData.url) {
        throw new Error(loginData.detail || loginData.error || "Arrow is not configured");
      }
      setArrowStatus({
        configured: Boolean(statusData.configured),
        hasAccessToken: Boolean(statusData.hasAccessToken),
        tokenSource: statusData.tokenSource,
        tokenFresh: statusData.tokenFresh,
        tokenExpiresAt: statusData.tokenExpiresAt,
        message: statusData.message,
        autoLogin: statusData.autoLogin,
        loginUrl: loginData.url,
      });
    } catch (err) {
      setArrowStatus({
        configured: false,
        error: getErrorMessage(err, "Arrow is not configured"),
      });
    }
  }, [adminHeaders]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      checkAuth();
      checkArrow();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [checkAuth, checkArrow]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("arrow") === "success") {
      setNotice("Arrow connected. You can now benchmark Arrow against Kite from the backend.");
    }
    if (params.get("arrow") === "error") {
      const message = params.get("message");
      setError(
        message
          ? `Arrow login failed: ${message}. Ask Arrow to enable this user for the configured Alpha Radar app ID, then generate a fresh Arrow login.`
          : "Arrow login failed. Generate a fresh Arrow login and try again."
      );
    }
    if (params.get("auth") === "success") {
      setNotice("Kite connected.");
    }
  }, []);

  const isAuth = authStatus?.authenticated;

  const runArrowAutoLogin = async () => {
    setArrowAutoLoginLoading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${API_URL}/api/arrow/auto-login`, {
        method: "POST",
        headers: adminHeaders,
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.detail || data.error || "Arrow automated login failed");
      }
      setNotice(`Arrow automated login succeeded. Token valid until ${formatArrowTime(data.expiresAt)} IST.`);
      await checkArrow();
    } catch (err) {
      setError(getErrorMessage(err, "Arrow automated login failed"));
      await checkArrow();
    } finally {
      setArrowAutoLoginLoading(false);
    }
  };

  const runBenchmark = async () => {
    setBenchmarkLoading(true);
    setBenchmarkError(null);
    try {
      const symbols = "RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK";
      const r = await fetch(`${API_URL}/api/arrow/benchmark/quotes?symbols=${encodeURIComponent(symbols)}`, {
        headers: adminHeaders,
      });
      const data = await r.json();
      if (!r.ok || !data.success) {
        throw new Error(data.detail || data.error || "Benchmark failed");
      }
      setBenchmark(data);
    } catch (err) {
      setBenchmarkError(getErrorMessage(err, "Benchmark failed"));
    } finally {
      setBenchmarkLoading(false);
    }
  };

  // Block non-admin users
  if (user && !isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-[400px] p-10">
          <div className="text-5xl mb-4">&#x1F512;</div>
          <h2 className="text-text-heading text-xl font-bold mb-2">Access Denied</h2>
          <p className="text-text-secondary text-[13px] mb-6 leading-relaxed">
            This page is restricted to administrators only.
          </p>
          <Link
            href="/"
            className="inline-block bg-accent text-white rounded-lg px-6 py-2.5 text-sm font-bold no-underline hover:bg-accent/80 transition-colors"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1500px] mx-auto">
      {/* Header */}
      <PageHeader eyebrow="Administration" title="Workspace administration" description="Manage subscribers, broker connections, coupons and customer feedback." />
      {/* Tabs */}
      <div className="sub-tabs mb-6">
        {([["subscribers", "Subscribers"], ["login", "Broker Login"], ["coupons", "Coupons"], ["feedback", "Feedback"]] as const).map(
          ([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
              className={`bg-transparent border-none px-5 py-2.5 text-[13px] font-semibold cursor-pointer transition-colors border-b-2 ${
                tab === key
                  ? "border-accent text-text-heading"
                  : "border-transparent text-text-secondary hover:text-muted"
              }`}
            >
              {label}
            </button>
          )
        )}
      </div>

      {tab === "subscribers" && (
        <SubscriberDashboard
          adminHeaders={adminHeaders}
          hasAdminCredentials={hasAdminCredentials(adminHeaders)}
        />
      )}

      {/* Login Tab */}
      {tab === "login" && (
        <div className="py-6">
          {error && (
            <div className="bg-loss-bg border border-loss/20 text-loss px-3 py-2 rounded-lg text-xs mb-4">
              {error}
            </div>
          )}
          {notice && (
            <div className="bg-accent/10 border border-accent/20 text-accent px-3 py-2 rounded-lg text-xs mb-4">
              {notice}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ProviderCard
              title="Zerodha Kite"
              subtitle="Current production market-data provider"
              status={isAuth ? "Connected" : "Not connected"}
              statusTone={isAuth ? "ok" : "warn"}
              description={isAuth ? "Re-login if the daily token expired." : "Sign in with Kite to enable live NSE data."}
              detail={isAuth ? `Vol: ${authStatus?.avgVolumeCacheSize ?? "-"} | PDH: ${authStatus?.pdhCacheSize ?? "-"}` : "Do this once every morning before 9:15 AM."}
              actionLabel={isAuth ? "RE-LOGIN WITH KITE" : "LOGIN WITH KITE"}
              actionHref={authStatus?.loginUrl}
              actionClass="bg-[#ff6f00] hover:bg-[#e56200]"
            />

            <ProviderCard
              title="Arrow Trade"
              subtitle={arrowStatus.autoLogin?.configured ? "Automated weekday login" : "Experimental faster data adapter"}
              status={arrowStatus.hasAccessToken ? "Connected" : arrowStatus.autoLogin?.configured ? "Auto-login ready" : arrowStatus.configured ? "Ready to login" : "Not configured"}
              statusTone={arrowStatus.hasAccessToken || arrowStatus.autoLogin?.configured ? "ok" : "warn"}
              description="Radar tries Arrow first for live quotes, then falls back to Kite if Arrow is unavailable."
              detail={
                arrowStatus.error ||
                (arrowStatus.autoLogin?.lastStatus === "error"
                  ? `Auto-login failed: ${arrowStatus.autoLogin.lastError || "Check backend logs."}`
                  : arrowStatus.autoLogin?.configured
                    ? `Runs at ${String(arrowStatus.autoLogin.schedule?.hour ?? 8).padStart(2, "0")}:${String(arrowStatus.autoLogin.schedule?.minute ?? 30).padStart(2, "0")} IST, Monday-Friday. Last success: ${formatArrowTime(arrowStatus.autoLogin.lastSuccessAt)}. Token expires: ${formatArrowTime(arrowStatus.tokenExpiresAt)}.`
                    : arrowStatus.autoLogin?.enabled
                      ? `Auto-login needs: ${(arrowStatus.autoLogin.missingSettings || []).join(", ") || "complete backend configuration"}.`
                      : arrowStatus.hasAccessToken
                  ? `Access token active from ${arrowStatus.tokenSource || "runtime"}. Kite is the safety fallback.`
                        : arrowStatus.message || "Access tokens expire daily. Re-login with Arrow to use Arrow-first Radar.")
              }
              actionLabel={arrowStatus.autoLogin?.configured ? (arrowAutoLoginLoading ? "LOGGING IN..." : "RUN AUTO-LOGIN NOW") : arrowStatus.hasAccessToken ? "RE-LOGIN WITH ARROW" : "LOGIN WITH ARROW"}
              actionHref={arrowStatus.autoLogin?.configured ? undefined : arrowStatus.loginUrl}
              actionOnClick={arrowStatus.autoLogin?.configured ? runArrowAutoLogin : undefined}
              actionDisabled={arrowAutoLoginLoading}
              actionClass="bg-accent hover:bg-accent/80"
              secondaryActionLabel={arrowStatus.autoLogin?.configured ? "Manual Arrow login fallback" : undefined}
              secondaryActionHref={arrowStatus.autoLogin?.configured ? arrowStatus.loginUrl : undefined}
            />
          </div>

          <div className="bg-card border border-card-border rounded-lg p-5 mt-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-text-heading text-base font-bold m-0">Data Provider Benchmark</h2>
                <p className="text-text-secondary text-xs mt-1">
                  Live Alpha Radar still uses Kite. This test compares Kite vs Arrow for the same quote basket.
                </p>
              </div>
              <button
                onClick={runBenchmark}
                disabled={benchmarkLoading || !isAuth || !arrowStatus.hasAccessToken}
                className="px-4 py-2.5 rounded-lg bg-text-heading text-white text-xs font-bold disabled:opacity-45 disabled:cursor-not-allowed"
              >
                {benchmarkLoading ? "RUNNING..." : "RUN BENCHMARK"}
              </button>
            </div>

            {(!isAuth || !arrowStatus.hasAccessToken) && (
              <div className="text-text-tertiary text-[11px] mt-3">
                Connect both Kite and Arrow to run this benchmark.
              </div>
            )}

            {benchmarkError && (
              <div className="bg-loss-bg border border-loss/20 text-loss px-3 py-2 rounded-lg text-xs mt-4">
                {benchmarkError}
              </div>
            )}

            {benchmark && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                <BenchmarkMetric
                  label="Kite"
                  value={`${Math.round(benchmark.kite?.elapsedMs ?? 0)} ms`}
                  detail={`${benchmark.kite?.returned ?? 0}/${benchmark.kite?.requested ?? 0} returned`}
                />
                <BenchmarkMetric
                  label="Arrow"
                  value={`${Math.round(benchmark.arrow?.elapsedMs ?? 0)} ms`}
                  detail={`${benchmark.arrow?.returned ?? 0}/${benchmark.arrow?.requested ?? 0} returned`}
                />
                <BenchmarkMetric
                  label="Current Live App"
                  value="Arrow First"
                  detail="Radar tries Arrow first, with Kite as fallback."
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Coupons Tab */}
      {tab === "coupons" && <CouponManager />}

      {/* Feedback Tab */}
      {tab === "feedback" && <FeedbackViewer />}
    </div>
  );
}

function ProviderCard({
  title,
  subtitle,
  status,
  statusTone,
  description,
  detail,
  actionLabel,
  actionHref,
  actionOnClick,
  actionDisabled,
  actionClass,
  secondaryActionLabel,
  secondaryActionHref,
}: {
  title: string;
  subtitle: string;
  status: string;
  statusTone: "ok" | "warn";
  description: string;
  detail: string;
  actionLabel: string;
  actionHref?: string;
  actionOnClick?: () => void;
  actionDisabled?: boolean;
  actionClass: string;
  secondaryActionLabel?: string;
  secondaryActionHref?: string;
}) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-5 text-left min-h-[245px] flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-text-heading text-base font-bold m-0">{title}</h2>
            <p className="text-text-secondary text-xs mt-1">{subtitle}</p>
          </div>
          <span
            className={`shrink-0 px-2.5 py-1 rounded text-[10px] font-bold ${
              statusTone === "ok"
                ? "bg-accent/10 text-accent border border-accent/20"
                : "bg-warning/10 text-warning border border-warning/20"
            }`}
          >
            {status}
          </span>
        </div>
        <p className="text-text-secondary text-[13px] leading-relaxed mb-3">{description}</p>
        <div className="text-text-tertiary text-[11px] leading-relaxed">{detail}</div>
      </div>

      <div className="mt-5 flex flex-col gap-2">
        {actionOnClick ? (
          <button
            type="button"
            onClick={actionOnClick}
            disabled={actionDisabled}
            className={`px-5 py-3 text-white rounded-lg text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${actionClass}`}
          >
            {actionLabel}
          </button>
        ) : actionHref ? (
          <a
            href={actionHref}
            className={`inline-flex justify-center items-center px-5 py-3 text-white rounded-lg text-sm font-bold no-underline transition-colors ${actionClass}`}
          >
            {actionLabel}
          </a>
        ) : (
          <button
            disabled
            className="px-5 py-3 rounded-lg text-sm font-bold bg-card-border/40 text-text-tertiary cursor-not-allowed"
          >
            {actionLabel}
          </button>
        )}
        {secondaryActionLabel && secondaryActionHref && (
          <a
            href={secondaryActionHref}
            className="text-center text-[11px] font-semibold text-text-secondary hover:text-text-heading transition-colors"
          >
            {secondaryActionLabel}
          </a>
        )}
      </div>
    </div>
  );
}

function BenchmarkMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-page-bg/70 border border-card-border rounded-lg px-4 py-3">
      <div className="text-text-secondary text-[11px] font-semibold">{label}</div>
      <div className="text-text-heading text-xl font-extrabold mt-1">{value}</div>
      <div className="text-text-tertiary text-[11px] mt-1 leading-relaxed">{detail}</div>
    </div>
  );
}

// -- COUPON MANAGER --
function CouponManager() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [stats, setStats] = useState({ total: 0, unused: 0, used: 0 });
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genCount, setGenCount] = useState(5);
  const [genDays, setGenDays] = useState(90);
  const [genLabel, setGenLabel] = useState("");
  const [filter, setFilter] = useState<"all" | "unused" | "used">("all");
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const adminHeaders = useAdminRequestHeaders();

  const fetchCoupons = useCallback(async () => {
    if (!hasAdminCredentials(adminHeaders)) {
      setMsg({ type: "error", text: "Admin session is still loading. Please refresh or sign in again." });
      return;
    }

    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/coupons/list`, { headers: adminHeaders });
      if (!r.ok) {
        const data = await r.json().catch(() => null);
        throw new Error(data?.detail || data?.error || "Failed to fetch coupons");
      }
      const data = await r.json();
      setCoupons(data.coupons || []);
      setStats({ total: data.total, unused: data.unused, used: data.used });
      setMsg(null);
    } catch (error) {
      setMsg({ type: "error", text: getErrorMessage(error, "Failed to load coupons") });
    } finally {
      setLoading(false);
    }
  }, [adminHeaders]);

  useEffect(() => {
    fetchCoupons();
  }, [fetchCoupons]);

  const handleGenerate = async () => {
    if (!hasAdminCredentials(adminHeaders)) {
      setMsg({ type: "error", text: "Admin session is still loading. Please refresh or sign in again." });
      return;
    }

    setGenerating(true);
    setMsg(null);
    try {
      const r = await fetch(`${API_URL}/api/coupons/generate`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ count: genCount, duration_days: genDays, label: genLabel || undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || data.error || "Failed to generate coupons");
      setMsg({ type: "success", text: `Generated ${data.generated} coupons: ${data.codes.join(", ")}` });
      fetchCoupons();
    } catch (error) {
      setMsg({ type: "error", text: getErrorMessage(error, "Failed to generate coupons") });
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/coupons/${id}`, { method: "DELETE", headers: adminHeaders });
      fetchCoupons();
    } catch {
      // ignore
    }
  };

  const handleRevert = async (id: string, email: string) => {
    if (!window.confirm(`Are you sure you want to revert this coupon?\n\n${email} will be downgraded from Premium to Free account immediately.`))
      return;
    try {
      const r = await fetch(`${API_URL}/api/coupons/${id}/revert`, {
        method: "POST",
        headers: adminHeaders,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || data.error || "Failed to revert coupon");
      setMsg({ type: "success", text: `Reverted! ${email} is now on Free plan.` });
      fetchCoupons();
    } catch (error) {
      setMsg({ type: "error", text: getErrorMessage(error, "Failed to revert coupon") });
    }
  };

  const filtered = coupons.filter((c) => {
    if (filter === "unused") return !c.used_by;
    if (filter === "used") return !!c.used_by;
    return true;
  });

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
    setMsg({ type: "success", text: `Copied: ${code}` });
    setTimeout(() => setMsg(null), 2000);
  };

  return (
    <div>
      {/* Stats */}
      <div className="flex gap-2.5 mb-5">
        {[
          { label: "TOTAL", val: stats.total, color: "text-text-heading" },
          { label: "UNUSED", val: stats.unused, color: "text-accent" },
          { label: "USED", val: stats.used, color: "text-warning" },
        ].map((s) => (
          <div
            key={s.label}
            className="flex-1 bg-surface-subtle border border-card-border rounded-[10px] py-3.5 px-4 text-center"
          >
            <div className="text-[9px] text-text-secondary tracking-[1.5px] font-bold">{s.label}</div>
            <div className={`text-2xl font-extrabold ${s.color}`}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Generate Form */}
      <div className="bg-surface-subtle border border-card-border rounded-xl p-[18px_20px] mb-4">
        <div className="text-xs font-bold text-text-heading mb-3">Generate New Coupons</div>
        <div className="flex gap-2 items-end flex-wrap">
          <div>
            <label className="block text-[10px] text-text-secondary tracking-[0.5px] font-semibold mb-1">
              Count
            </label>
            <input
              type="number"
              value={genCount}
              onChange={(e) => setGenCount(+e.target.value)}
              min={1}
              max={100}
              className="bg-input-bg border border-input-border rounded-md px-2.5 py-2 text-[13px] text-text-heading w-20 outline-none focus:border-accent/50"
            />
          </div>
          <div>
            <label className="block text-[10px] text-text-secondary tracking-[0.5px] font-semibold mb-1">
              Duration (days)
            </label>
            <input
              type="number"
              value={genDays}
              onChange={(e) => setGenDays(+e.target.value)}
              min={1}
              className="bg-input-bg border border-input-border rounded-md px-2.5 py-2 text-[13px] text-text-heading w-20 outline-none focus:border-accent/50"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[10px] text-text-secondary tracking-[0.5px] font-semibold mb-1">
              Label (optional)
            </label>
            <input
              type="text"
              value={genLabel}
              onChange={(e) => setGenLabel(e.target.value)}
              placeholder="e.g. Trading Course Batch 1"
              className="bg-input-bg border border-input-border rounded-md px-2.5 py-2 text-[13px] text-text-heading w-full outline-none focus:border-accent/50"
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="bg-accent text-white border-none rounded-lg px-[18px] py-2.5 text-xs font-bold cursor-pointer whitespace-nowrap hover:bg-accent/80 disabled:opacity-60 transition-colors"
          >
            {generating ? "Generating..." : `Generate ${genCount} Coupons`}
          </button>
        </div>
      </div>

      {/* Message */}
      {msg && (
        <div
          className={`px-3.5 py-2.5 rounded-lg text-xs mb-3.5 border break-all ${
            msg.type === "success"
              ? "bg-accent/10 border-accent/30 text-accent"
              : "bg-loss-bg border-loss/30 text-loss"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-1.5 mb-3.5 items-center">
        {(["all", "unused", "used"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-[5px] rounded-md text-[11px] font-semibold cursor-pointer border transition-colors ${
              filter === f
                ? "bg-accent/[0.15] border-accent/30 text-accent"
                : "bg-transparent border-card-border text-text-secondary hover:text-muted"
            }`}
          >
            {f.toUpperCase()} ({f === "all" ? stats.total : f === "unused" ? stats.unused : stats.used})
          </button>
        ))}
        <button
          onClick={fetchCoupons}
          className="ml-auto bg-transparent border border-card-border text-text-secondary px-3 py-[5px] rounded-md text-[11px] cursor-pointer hover:text-muted transition-colors"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* Coupon List */}
      <div className="bg-surface-subtle border border-card-border rounded-xl overflow-hidden">
        {/* Table Header */}
        <div className="flex px-4 py-2.5 text-[9px] font-bold tracking-[1px] text-text-tertiary border-b border-card-border bg-surface-subtle">
          <div className="flex-[2]">CODE</div>
          <div className="flex-[2]">LABEL</div>
          <div className="flex-1 text-center">DAYS</div>
          <div className="flex-1 text-center">STATUS</div>
          <div className="flex-[3]">USED BY</div>
          <div className="flex-[2]">USED AT</div>
          <div className="flex-1 text-center">ACTION</div>
        </div>
        {filtered.length === 0 && (
          <div className="p-8 text-center text-text-tertiary text-[13px]">
            {loading ? "Loading..." : "No coupons found"}
          </div>
        )}
        {filtered.map((c, i) => (
          <div
            key={c.id}
            className={`flex px-4 py-2.5 border-b border-card-border/50 items-center text-xs ${
              i % 2 === 0 ? "bg-stripe-bg" : "bg-transparent"
            }`}
          >
            <div className="flex-[2]">
              <span
                className={`font-mono font-bold cursor-pointer text-xs ${
                  c.used_by ? "text-text-secondary" : "text-text-heading"
                }`}
                onClick={() => copyCode(c.code)}
                title="Click to copy"
              >
                {c.code}
              </span>
            </div>
            <div className="flex-[2] text-[11px] text-text-secondary">{c.label || "\u2014"}</div>
            <div className="flex-1 text-center text-xs text-muted">{c.duration_days}d</div>
            <div className="flex-1 text-center">
              {c.used_by ? (
                <span className="bg-warning/[0.15] text-warning px-2 py-0.5 rounded text-[10px] font-bold">
                  USED
                </span>
              ) : (
                <span className="bg-accent/[0.15] text-accent px-2 py-0.5 rounded text-[10px] font-bold">
                  ACTIVE
                </span>
              )}
            </div>
            <div className={`flex-[3] text-[11px] ${c.used_by ? "text-muted" : "text-text-tertiary"}`}>
              {c.used_by_email || "\u2014"}
            </div>
            <div className="flex-[2] text-[11px] text-text-secondary">
              {c.used_at
                ? new Date(c.used_at).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "\u2014"}
            </div>
            <div className="flex-1 text-center flex gap-1 justify-center">
              {!c.used_by && (
                <button
                  onClick={() => handleDelete(c.id)}
                  className="bg-loss/10 border border-loss/20 text-loss px-2 py-[3px] rounded text-[10px] cursor-pointer font-semibold hover:bg-loss/20 transition-colors"
                >
                  Delete
                </button>
              )}
              {c.used_by && (
                <button
                  onClick={() => handleRevert(c.id, c.used_by_email || "")}
                  className="bg-warning/10 border border-warning/20 text-warning px-2 py-[3px] rounded text-[10px] cursor-pointer font-semibold hover:bg-warning/20 transition-colors"
                >
                  Revert
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// -- FEEDBACK VIEWER --
function FeedbackViewer() {
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filterCat, setFilterCat] = useState("all");
  const adminHeaders = useAdminRequestHeaders();

  const fetchFeedbacks = useCallback(async () => {
    if (!hasAdminCredentials(adminHeaders)) return;

    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/feedback/list`, { headers: adminHeaders });
      if (!r.ok) throw new Error("Failed to fetch");
      const data = await r.json();
      setFeedbacks(data.feedback || []);
      setTotal(data.total || 0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [adminHeaders]);

  useEffect(() => {
    fetchFeedbacks();
  }, [fetchFeedbacks]);

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this feedback?")) return;
    try {
      await fetch(`${API_URL}/api/feedback/${id}`, { method: "DELETE", headers: adminHeaders });
      fetchFeedbacks();
    } catch {
      // ignore
    }
  };

  const categories = ["all", "general", "feature_request", "improvement", "missing_tool", "bug"];
  const catLabels: Record<string, string> = {
    all: "All",
    general: "General",
    feature_request: "Feature Request",
    improvement: "Improvement",
    missing_tool: "Missing Tool",
    bug: "Bug",
  };
  const catColors: Record<string, string> = {
    general: "#94a3b8",
    feature_request: "#3b82f6",
    improvement: "#10b981",
    missing_tool: "#f59e0b",
    bug: "#ef4444",
  };

  const filtered = filterCat === "all" ? feedbacks : feedbacks.filter((f) => f.category === filterCat);

  return (
    <div>
      {/* Stats */}
      <div className="flex gap-2.5 mb-5">
        <div className="flex-1 bg-surface-subtle border border-card-border rounded-[10px] py-3.5 px-4 text-center">
          <div className="text-[9px] text-text-secondary tracking-[1.5px] font-bold">TOTAL</div>
          <div className="text-2xl font-extrabold text-text-heading">{total}</div>
        </div>
        {(["feature_request", "improvement", "bug"] as const).map((cat) => (
          <div
            key={cat}
            className="flex-1 bg-surface-subtle border border-card-border rounded-[10px] py-3.5 px-4 text-center"
          >
            <div className="text-[9px] text-text-secondary tracking-[1.5px] font-bold">
              {catLabels[cat].toUpperCase()}
            </div>
            <div className="text-2xl font-extrabold" style={{ color: catColors[cat] }}>
              {feedbacks.filter((f) => f.category === cat).length}
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 mb-3.5 items-center">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilterCat(cat)}
            className={`px-3 py-[5px] rounded-md text-[11px] font-semibold cursor-pointer border transition-colors ${
              filterCat === cat
                ? "bg-accent/[0.15] border-accent/30 text-accent"
                : "bg-transparent border-card-border text-text-secondary hover:text-muted"
            }`}
          >
            {catLabels[cat]}
          </button>
        ))}
        <button
          onClick={fetchFeedbacks}
          className="ml-auto bg-transparent border border-card-border text-text-secondary px-3 py-[5px] rounded-md text-[11px] cursor-pointer hover:text-muted transition-colors"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* Feedback list */}
      <div className="flex flex-col gap-2">
        {filtered.length === 0 && (
          <div className="p-10 text-center text-text-tertiary text-[13px] bg-surface-subtle rounded-xl border border-card-border">
            {loading ? "Loading..." : "No feedback yet"}
          </div>
        )}
        {filtered.map((f) => (
          <div
            key={f.id}
            className="bg-surface-subtle border border-card-border rounded-xl px-[18px] py-4"
          >
            <div className="flex justify-between items-start mb-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold text-text-heading">
                  {f.user_name || "Anonymous"}
                </span>
                <span className="text-[11px] text-text-secondary">{f.user_email}</span>
                <span
                  className="px-2 py-0.5 rounded text-[9px] font-bold border"
                  style={{
                    background: `${catColors[f.category] || "#94a3b8"}20`,
                    color: catColors[f.category] || "#94a3b8",
                    borderColor: `${catColors[f.category] || "#94a3b8"}30`,
                  }}
                >
                  {catLabels[f.category] || f.category}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {f.rating && (
                  <span className="text-amber-500 text-xs">
                    {"\u2605".repeat(f.rating)}
                    {"\u2606".repeat(5 - f.rating)}
                  </span>
                )}
                <span className="text-[10px] text-text-tertiary">
                  {new Date(f.created_at).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <button
                  onClick={() => handleDelete(f.id)}
                  className="bg-loss/10 border border-loss/20 text-loss px-1.5 py-0.5 rounded text-[9px] cursor-pointer hover:bg-loss/20 transition-colors"
                >
                  Del
                </button>
              </div>
            </div>
            <div className="text-[13px] text-foreground leading-[1.7] whitespace-pre-wrap">
              {f.message}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
