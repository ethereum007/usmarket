"use client";

import { PageHeader } from "../components/layout/PageHeader";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";

export default function SettingsPage() {
  const router = useRouter();
  const { user, subscription, signOut, loading } = useAuth();
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name || "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Password change
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPw, setChangingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const isPremium = subscription?.tier === "premium" && subscription?.is_active;
  const avatarUrl = user?.user_metadata?.avatar_url;
  const initials = (fullName || user?.email || "U")
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const provider = user?.app_metadata?.provider || "email";

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-accent">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const handleSaveName = async () => {
    if (!fullName.trim() || !supabase) return;
    setSaving(true);
    setMsg(null);
    try {
      const { error } = await supabase.auth.updateUser({ data: { full_name: fullName.trim() } });
      if (error) throw error;
      setMsg({ type: "success", text: "Name updated successfully" });
    } catch (err: any) {
      setMsg({ type: "error", text: err.message || "Failed to update" });
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (newPassword.length < 6) return setPwMsg({ type: "error", text: "Password must be at least 6 characters" });
    if (newPassword !== confirmPassword) return setPwMsg({ type: "error", text: "Passwords don't match" });

    setChangingPw(true);
    try {
      if (!supabase) throw new Error("Supabase not configured");
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setPwMsg({ type: "success", text: "Password updated successfully" });
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setPwMsg({ type: "error", text: err.message || "Failed to update password" });
    } finally {
      setChangingPw(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    router.replace("/login");
  };

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader eyebrow="Your workspace" title="Account settings" description="Manage your profile, sign-in details and membership." />
      {/* Profile Header */}
      <div className="flex items-center gap-4 mb-8">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="w-14 h-14 rounded-full border-2 border-card-border"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-14 h-14 rounded-full bg-card border border-card-border flex items-center justify-center text-xl font-bold text-foreground">
            {initials}
          </div>
        )}
        <div>
          <h2 className="text-[22px] font-bold text-text-heading m-0">
            {fullName || user?.email}
          </h2>
          <div className="text-[13px] text-text-secondary mt-0.5">{user?.email}</div>
          <div className="flex gap-1.5 mt-1.5">
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                isPremium
                  ? "bg-accent/[0.13] text-accent border-accent/[0.25]"
                  : "bg-surface-subtle text-text-secondary border-card-border"
              }`}
            >
              {isPremium ? "PREMIUM" : "FREE"}
            </span>
            <span className="text-[10px] text-text-tertiary px-2 py-0.5 bg-surface-subtle rounded border border-card-border">
              via {provider === "google" ? "Google" : "Email"}
            </span>
          </div>
        </div>
      </div>

      {/* Personal Info */}
      <div className="bg-card border border-card-border rounded-xl p-6 mb-5">
        <h3 className="text-[15px] font-bold text-text-heading mb-4">Personal Information</h3>

        {msg && (
          <div
            className={`px-3 py-2 rounded-lg text-xs mb-3.5 border ${
              msg.type === "success"
                ? "bg-accent/10 border-accent/20 text-accent"
                : "bg-loss-bg border-loss/20 text-loss"
            }`}
          >
            {msg.text}
          </div>
        )}

        <div className="mb-3.5">
          <label className="block text-xs font-semibold text-text-secondary mb-[5px]">Full Name</label>
          <div className="flex gap-2">
            <input aria-label="Full name" autoComplete="name"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your name"
              className="flex-1 px-3.5 py-2.5 bg-input-bg border border-input-border rounded-lg text-sm text-text-heading outline-none focus:border-accent/50 transition-colors"
            />
            <button
              onClick={handleSaveName}
              disabled={saving || !fullName.trim()}
              className="px-[18px] py-2.5 bg-accent text-white border-none rounded-lg text-xs font-bold cursor-pointer disabled:opacity-60 hover:bg-accent/80 transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-[5px]">Email</label>
          <input aria-label="Account email"
            type="email"
            value={user?.email || ""}
            disabled
            className="w-full px-3.5 py-2.5 bg-surface-subtle border border-card-border rounded-lg text-sm text-text-tertiary cursor-not-allowed"
          />
          <div className="text-[11px] text-text-tertiary mt-1">Email cannot be changed</div>
        </div>
      </div>

      {/* Change Password */}
      <div className="bg-card border border-card-border rounded-xl p-6 mb-5">
        <h3 className="text-[15px] font-bold text-text-heading mb-1">Change Password</h3>
        <p className="text-xs text-text-secondary mb-4">
          {provider === "google"
            ? "Set a password to also log in with email + password."
            : "Update your current password."}
        </p>

        {pwMsg && (
          <div
            className={`px-3 py-2 rounded-lg text-xs mb-3.5 border ${
              pwMsg.type === "success"
                ? "bg-accent/10 border-accent/20 text-accent"
                : "bg-loss-bg border-loss/20 text-loss"
            }`}
          >
            {pwMsg.text}
          </div>
        )}

        <form onSubmit={handleChangePassword}>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-text-secondary mb-[5px]">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 6 characters"
              minLength={6}
              className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-lg text-sm text-text-heading outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div className="mb-4">
            <label className="block text-xs font-semibold text-text-secondary mb-[5px]">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              className={`w-full px-3.5 py-2.5 bg-input-bg border rounded-lg text-sm text-text-heading outline-none focus:border-accent/50 transition-colors ${
                confirmPassword && confirmPassword !== newPassword
                  ? "border-loss"
                  : "border-input-border"
              }`}
            />
          </div>
          <button
            type="submit"
            disabled={changingPw || !newPassword || !confirmPassword}
            className="px-6 py-2.5 bg-accent text-white border-none rounded-lg text-[13px] font-bold cursor-pointer disabled:opacity-60 hover:bg-accent/80 transition-colors"
          >
            {changingPw ? "Updating..." : "Update Password"}
          </button>
        </form>
      </div>

      {/* Subscription */}
      <div className="bg-card border border-card-border rounded-xl p-6 mb-5">
        <h3 className="text-[15px] font-bold text-text-heading mb-3">Subscription</h3>
        <div className="flex justify-between items-center">
          <div>
            <div className={`text-sm font-semibold ${isPremium ? "text-accent" : "text-foreground"}`}>
              {isPremium ? "Premium Plan" : "Free Plan"}
            </div>
            {subscription?.expires_at && isPremium && (
              <div className="text-xs text-text-secondary mt-0.5">
                Expires{" "}
                {new Date(subscription.expires_at).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </div>
            )}
          </div>
          {!isPremium && (
            <button
              onClick={() => router.push("/subscription")}
              className="px-5 py-2 bg-accent text-white border-none rounded-lg text-xs font-bold cursor-pointer hover:bg-accent/80 transition-colors"
            >
              Upgrade
            </button>
          )}
        </div>
      </div>

      {/* Sign Out */}
      <button
        onClick={handleLogout}
        className="w-full py-3 bg-transparent border border-loss/20 rounded-[10px] text-[13px] font-semibold text-loss cursor-pointer hover:bg-loss-bg transition-colors"
      >
        Sign Out
      </button>
    </div>
  );
}
