"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Activity, ArrowUpRight, Layers3, Moon, ShieldCheck, Sun } from "lucide-react";
import { Brand } from "../layout/WorkspaceNav";
import { useTheme } from "../../lib/theme";

export function AuthFrame({ children, preview }: { children: ReactNode; preview?: ReactNode }) {
  const { isDark, toggleTheme } = useTheme();
  return <main className="auth-page">
    <header className="auth-topbar"><Brand /><div className="flex items-center gap-4"><Link href="/" className="text-xs text-muted hover:text-accent">Explore the market <ArrowUpRight size={13} className="inline" /></Link><button onClick={toggleTheme} className="icon-button" aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}>{isDark ? <Sun size={18} /> : <Moon size={18} />}</button></div></header>
    <div className="auth-layout">
      <section className="auth-story">
        <p className="eyebrow text-accent">Clarity for every trading day</p>
        <h2>Find your edge.<br /><span className="text-accent">Keep your perspective.</span></h2>
        <p className="auth-intro">Your market, signals and risk context in one considered workspace. Built for the way you trade.</p>
        {preview}
        <div className="auth-features">
          <div><Activity size={18} /><span><strong>Read the market</strong><small>Breadth, momentum and sector rotation.</small></span></div>
          <div><Layers3 size={18} /><span><strong>See the complete setup</strong><small>Price, volume and options positioning.</small></span></div>
          <div><ShieldCheck size={18} /><span><strong>Keep risk in view</strong><small>Entry, invalidation and data freshness.</small></span></div>
        </div>
      </section>
      <section className="auth-form-column"><div className="auth-card">{children}</div><p className="mt-6 text-center text-xs text-muted">A focused workspace for Indian markets.</p></section>
    </div>
    <footer className="auth-footer"><span>Alpha Radar · Trading intelligence</span><span>Screening and analysis only. Not investment advice.</span></footer>
  </main>;
}
