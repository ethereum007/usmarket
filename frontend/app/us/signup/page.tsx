"use client";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import { requestUSSignup, US_SIGNUP_ENABLED } from "../../lib/us-signup";

export default function USSignupPage() {
  const { user, loading, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const pending = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || user) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await requestUSSignup(email, password, confirmation, window.location.origin);
      setPassword("");
      setConfirmation("");
      setStatus(result.state);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Signup is unavailable. Retry later.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6 py-12">
    <p className="text-sm text-text-secondary">ALPHA RADAR US</p><h1 className="text-3xl font-semibold">Create your US account</h1>
    {!US_SIGNUP_ENABLED || !supabase ? <p role="status">Self-service signup is not enabled. Contact your beta administrator for access.</p> : loading ? <p role="status">Checking your session…</p> : status === "check_email" ? <p role="status">If this address is eligible, check your inbox and spam folder for confirmation. You can also use sign-in or password recovery. Access requires confirmed email status.</p> : status ? <p role="alert">Signup returned an unexpected signed-in session. Email-confirmation configuration needs operator review.{status === "cleanup_required" ? " Sign-out could not be confirmed; retry below." : " The local session was signed out."}</p> : user ? <p>You already have a session. Sign out before requesting another account.</p> : <form className="space-y-4" onSubmit={submit}>
      <label className="block">Email<input className="workspace-input w-full" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label className="block">Password<input className="workspace-input w-full" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label className="block">Confirm password<input className="workspace-input w-full" type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      <button className="workspace-button workspace-button-primary" disabled={busy} type="submit">{busy ? "Requesting…" : "Request account confirmation"}</button>
    </form>}
    {(user || status === "cleanup_required") && <button type="button" className="workspace-button" disabled={busy} onClick={() => { setBusy(true); void signOut().then(() => setStatus("")).catch(() => setError("Sign-out could not be confirmed. Retry shortly.")).finally(() => setBusy(false)); }}>Sign out</button>}
    {error && <p role="alert">{error}</p>}
    <Link href="/us/login" className="underline">US sign-in</Link><Link href="/us/recover" className="underline">Recover your account</Link>
  </main>;
}
