"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { AuthFrame } from "../components/auth/AuthFrame";
import { supabase } from "../lib/supabase";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!email.trim()) {
      setError("Enter the email linked to your Alpha Radar account.");
      return;
    }
    if (!supabase) {
      setError("Login service is not configured. Please try again shortly.");
      return;
    }

    setLoading(true);
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });
    setLoading(false);

    if (resetError) {
      setError(resetError.message || "Could not send reset email. Please try again.");
      return;
    }

    setMessage("Password reset link sent. Please check your email and open the link in this browser.");
  }

  return (
    <AuthFrame>
        <div>
          <Link href="/login" className="text-sm font-bold text-accent hover:underline">
            Back to login
          </Link>

          <div className="mt-8">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Alpha Radar</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[0]">Reset password</h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              Enter your account email. We will send a secure reset link so you can create a new password.
            </p>
          </div>

          {error && (
            <div className="mt-6 rounded-xl border border-[#ff6b6b]/30 bg-[#ff6b6b]/10 px-4 py-3 text-sm font-semibold text-loss">
              {error}
            </div>
          )}

          {message && (
            <div className="mt-6 rounded-xl border border-[#2fd07c]/30 bg-accent/10 px-4 py-3 text-sm font-semibold text-profit">
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-7 space-y-5">
            <label className="block">
              <span className="text-sm font-bold text-muted">Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                className="mt-2 h-12 w-full rounded-xl border border-card-border bg-background px-4 text-sm font-semibold text-text-heading outline-none transition placeholder:text-[#64748b] focus:border-[#7cc4ff] focus:ring-4 focus:ring-[#7cc4ff]/10"
              />
            </label>

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-[var(--accent-solid)] px-5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Sending reset link..." : "Send reset link"}
            </button>
          </form>
        </div>
    </AuthFrame>
  );
}
