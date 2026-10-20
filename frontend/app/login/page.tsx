"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { fetchAPI, postAPI } from "../lib/api";
import { getUniverse } from "../lib/stock-universe";
import { AuthFrame } from "../components/auth/AuthFrame";

type Candidate = { symbol: string; bias: string; score: number; changePct?: number; volRatio?: number; sector?: string; action: string; setups?: string[] };
type RadarPreview = { success?: boolean; cached?: boolean; timestamp?: number; marketRegime?: { label?: string }; summary?: { total?: number; long?: number; short?: number; actionable?: number }; candidates?: Candidate[] };
type IndexQuote = { key?: string; name?: string; ltp?: number; last?: number; chg?: number; chgPct?: number; changePct?: number };

export default function LoginPage() {
  const { user, loading: authLoading, signIn, signInWithGoogle } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSignup, setNeedsSignup] = useState(false);
  const [radar, setRadar] = useState<RadarPreview | null>(null);
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [previewLoading, setPreviewLoading] = useState(true);

  useEffect(() => { if (!authLoading && user) router.replace("/"); }, [authLoading, user, router]);
  useEffect(() => { setEmail(new URLSearchParams(window.location.search).get("email") || ""); }, []);
  useEffect(() => {
    let active = true;
    async function load() {
      const [quotes, result] = await Promise.allSettled([
        fetchAPI<{ indices?: IndexQuote[]; data?: IndexQuote[] }>("/api/quotes/indices"),
        postAPI<RadarPreview>("/api/intraday/radar", { symbols: getUniverse("nifty100"), minTradedValueLakh: 0, useCache: true, quoteProvider: "arrow_first" }),
      ]);
      if (!active) return;
      if (quotes.status === "fulfilled") setIndices(quotes.value.indices || quotes.value.data || []);
      if (result.status === "fulfilled" && result.value.success) setRadar(result.value);
      setPreviewLoading(false);
    }
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError(null); setNeedsSignup(false); setSubmitting(true);
    try {
      const result = await signIn(email.trim(), password);
      if (result.error) {
        setNeedsSignup(result.userNotFound);
        setError(result.userNotFound ? "Check your email and password, or create an account to get started." : result.error.includes("Email not confirmed") ? "Please verify your email first using the code in your inbox." : result.error);
      }
    } catch { setError("We couldn't sign you in. Please try again."); }
    finally { setSubmitting(false); }
  }
  async function handleGoogle() {
    setError(null); setSubmitting(true);
    try { const result = await signInWithGoogle(); if (result.error) setError(result.error); }
    catch { setError("Google sign-in is unavailable. Please try again."); }
    finally { setSubmitting(false); }
  }
  const candidates = [...(radar?.candidates || [])].sort((a, b) => b.score - a.score).slice(0, 4);

  return <AuthFrame preview={<div className="auth-preview">
    <div className="flex items-center justify-between border-b border-card-border px-5 py-4"><span className="text-xs font-semibold text-text-heading">The opportunity desk</span><span className="text-[11px] text-muted">{previewLoading ? "Connecting…" : radar ? radar.cached ? "Previous-session snapshot" : "Latest available data" : "Preview unavailable"}</span></div>
    {indices.length > 0 && <div className="grid grid-cols-2 border-b border-card-border">{indices.slice(0, 2).map((index, i) => <div key={index.key || index.name || i} className="px-5 py-3"><p className="text-[10px] text-muted">{index.key || index.name}</p><p className="mt-1 font-mono text-sm text-text-heading">{(index.ltp ?? index.last)?.toLocaleString("en-IN") ?? "—"}<span className={`ml-3 text-xs ${(index.chgPct ?? index.changePct ?? index.chg ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>{(index.chgPct ?? index.changePct ?? index.chg ?? 0).toFixed(2)}%</span></p></div>)}</div>}
    {candidates.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="text-muted"><th className="px-5 py-3 font-normal">Symbol</th><th className="px-3 font-normal">Bias</th><th className="px-3 text-right font-normal">Move</th><th className="px-5 text-right font-normal">Score</th></tr></thead><tbody>{candidates.map(row => <tr key={row.symbol} className="border-t border-card-border"><td className="px-5 py-3 font-medium text-text-heading">{row.symbol}<span className="mt-1 block text-[10px] font-normal text-muted">{row.sector || "NSE"}</span></td><td className={`px-3 ${row.bias === "LONG" ? "text-profit" : row.bias === "SHORT" ? "text-loss" : "text-muted"}`}>{row.bias}</td><td className={`px-3 text-right font-mono ${(row.changePct ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>{(row.changePct ?? 0) > 0 ? "+" : ""}{row.changePct?.toFixed(2) ?? "—"}%</td><td className="px-5 text-right font-mono text-text-heading">{Math.round(row.score)}</td></tr>)}</tbody></table></div> : <p className="px-5 py-8 text-sm text-muted">{previewLoading ? "Loading the latest market snapshot…" : "Explore the workspace to view available market data."}</p>}
    {radar?.summary && <div className="flex flex-wrap gap-4 border-t border-card-border px-5 py-3 text-[11px] text-muted"><span>{radar.summary.total ?? "—"} candidates</span><span>{radar.summary.long ?? "—"} long</span><span>{radar.summary.short ?? "—"} short</span><span>{radar.summary.actionable ?? "—"} actionable</span></div>}
    <Link href="/" className="flex items-center justify-between border-t border-card-border px-5 py-3 text-xs text-accent">Explore the market overview<ArrowRight size={14} /></Link>
  </div>}>
    <div className="mb-8"><p className="eyebrow mb-3">Your trading workspace</p><h1 className="text-3xl font-semibold tracking-tight text-text-heading">Welcome back.</h1><p className="mt-3 text-sm text-muted">Sign in to pick up where you left off.</p></div>
    <button onClick={handleGoogle} disabled={submitting || authLoading} className="auth-secondary-button">Continue with Google</button>
    <div className="auth-divider"><span>or sign in with email</span></div>
    {error && <div role="alert" className="mb-5 rounded-lg border border-loss/25 bg-loss-bg p-3 text-sm text-loss">{error}{needsSignup && <Link href="/signup" className="mt-2 block font-medium underline">Create an account</Link>}</div>}
    <form onSubmit={handleLogin} className="space-y-5">
      <div><label htmlFor="login-email" className="auth-label">Email address</label><input id="login-email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required className="auth-input" /></div>
      <div><div className="mb-2 flex items-center justify-between"><label htmlFor="login-password" className="auth-label mb-0">Password</label><Link href="/forgot-password" className="text-xs text-accent hover:underline">Forgot password?</Link></div><div className="relative"><input id="login-password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={e => setPassword(e.target.value)} required className="auth-input pr-12" /><button type="button" className="absolute right-1 top-1 icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></div>
      <button disabled={submitting || authLoading} className="auth-primary-button" type="submit">{submitting ? "Signing in…" : authLoading ? "Preparing sign-in…" : "Sign in to Alpha Radar"}<ArrowRight size={16} /></button>
    </form>
    <p className="mt-6 text-center text-sm text-muted">New here? <Link href="/signup" className="font-medium text-accent hover:underline">Create an account</Link></p>
    <p className="mt-7 flex items-center justify-center gap-2 text-[11px] text-muted"><LockKeyhole size={13} />Secure access to your workspace</p>
  </AuthFrame>;
}
