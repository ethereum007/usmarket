"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useRef, useEffect, type FormEvent } from "react";
import { Search } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../lib/theme";
import { PremiumBadge } from "../premium/PremiumBadge";

const ADMIN_EMAILS = ["charan@trezofin.ai", "balaji.kdutta@gmail.com"];

type NavTab = {
  href: string;
  label: string;
  premium?: boolean;
  tradeTabs?: string[];
};

const NAV_TABS: NavTab[] = [
  { href: "/", label: "Today" },
  { href: "/latest-updates", label: "Latest Updates" },
  { href: "/pulse", label: "Alpha Radar", premium: true },
  { href: "/sectors", label: "Sectors" },
  { href: "/heatmap", label: "Heatmap" },
  { href: "/analysis", label: "Analysis", premium: true },
  { href: "/options", label: "Options Flow", premium: true },
  { href: "/trade-ideas?tab=swing", label: "Swing", premium: true, tradeTabs: ["swing", "abnormal", "bounce52w", "instbuy"] },
  { href: "/stocks", label: "Screener" },
  { href: "/trade-ideas?tab=performance", label: "Track", premium: true, tradeTabs: ["performance", "alerts", "algos"] },
];

function isTabActive(pathname: string, href: string, currentTradeTab: string | null, tradeTabs?: string[]): boolean {
  if (href === "/") return pathname === "/";
  if (tradeTabs) {
    return pathname === "/trade-ideas" && tradeTabs.includes(currentTradeTab || "signals");
  }
  return pathname.startsWith(href);
}

function ThemeModeButton({
  isDark,
  toggleTheme,
  compact = false,
}: {
  isDark: boolean;
  toggleTheme: () => void;
  compact?: boolean;
}) {
  return (
    <button
      onClick={toggleTheme}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 font-black text-warning shadow-sm shadow-warning/10 transition-all hover:-translate-y-px hover:border-warning/60 hover:bg-warning/15",
        compact ? "h-9 w-9" : "h-10 px-4 text-xs",
      )}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ) : (
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
      {!compact && <span>{isDark ? "Light Mode" : "Dark Mode"}</span>}
    </button>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, signOut } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [navSearch, setNavSearch] = useState("");
  const profileRef = useRef<HTMLDivElement>(null);

  const isAdmin = user && ADMIN_EMAILS.includes(user.email?.toLowerCase() || "");
  const visibleTabs = isAdmin
    ? [...NAV_TABS, { href: "/runner", label: "Runner Lab" }]
    : NAV_TABS;

  // Close profile dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  async function handleLogout() {
    await signOut();
    router.push("/login");
  }

  function handleNavSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const symbol = navSearch.trim().toUpperCase();
    if (!symbol) {
      router.push("/stocks?universe=all");
      return;
    }
    router.push(`/stocks?symbol=${encodeURIComponent(symbol)}&universe=all`);
    setNavSearch("");
  }

  // Live clock + market hours check (IST: 9:15 AM - 3:30 PM, Mon-Fri)
  const [clockStr, setClockStr] = useState("");
  const [isMarketOpen, setIsMarketOpen] = useState(false);

  useEffect(() => {
    function tick() {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
      const h = istTime.getHours();
      const m = istTime.getMinutes();
      const s = istTime.getSeconds();
      const timeInMinutes = h * 60 + m;
      const day = istTime.getDay();
      const isWeekday = day >= 1 && day <= 5;
      setIsMarketOpen(isWeekday && timeInMinutes >= 555 && timeInMinutes <= 930);
      setClockStr(
        `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")} IST`
      );
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-nav-border bg-nav-bg/95 shadow-[0_10px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl">
      <div className="flex min-h-16 items-center gap-2 px-3 lg:px-5">
        {/* Logo */}
        <Link href="/" className="mr-2 flex shrink-0 items-center gap-3 rounded-xl border border-card-border bg-card/70 px-3 py-2 shadow-sm transition hover:border-accent/40 lg:mr-3 min-[1900px]:mr-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-accent/25 bg-accent-bg">
            <svg className="h-5 w-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 17l5-5 4 4 7-9" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 7h6v6" />
            </svg>
          </span>
          <span className="leading-tight">
            <span className="block text-base font-black tracking-tight">
              <span className="text-accent">ALPHA</span>
              <span className="ml-1 text-text-heading">RADAR</span>
            </span>
            <span className="hidden text-[10px] font-bold uppercase tracking-[0.18em] text-muted sm:block">Trading Intelligence</span>
          </span>
        </Link>

        {/* Desktop Nav Tabs */}
        <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex">
          {visibleTabs.map((tab) => {
            const active = isTabActive(pathname, tab.href, searchParams.get("tab"), tab.tradeTabs);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "relative shrink-0 rounded-lg border px-2.5 py-2 text-[12px] font-bold transition-all min-[1900px]:px-3 min-[1900px]:text-[13px] min-[2200px]:px-4",
                  active
                    ? "border-accent/25 bg-accent-bg text-accent shadow-sm"
                    : "border-transparent text-muted hover:border-card-border hover:bg-surface-hover hover:text-foreground"
                )}
              >
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {tab.label}
                  {tab.premium && <PremiumBadge />}
                </span>
                {active && <span className="absolute -bottom-[13px] left-3 right-3 h-0.5 rounded-full bg-accent" />}
              </Link>
            );
          })}
        </div>

        {/* Right side items */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 min-[1900px]:gap-2.5">
          <form
            onSubmit={handleNavSearch}
            className="hidden h-10 w-[280px] items-center gap-2 rounded-full border border-card-border bg-page-bg/80 px-4 text-xs text-muted shadow-inner min-[1900px]:flex min-[2200px]:w-[360px]"
          >
            <Search className="h-4 w-4 shrink-0" />
            <input
              value={navSearch}
              onChange={(event) => setNavSearch(event.target.value)}
              placeholder="Search stock, index, sector..."
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted"
            />
            <span className="rounded border border-card-border px-1.5 py-0.5 font-mono text-[10px] text-muted">Ctrl /</span>
          </form>

          {/* Market Status + Live Clock */}
          <div className="hidden items-center gap-2 rounded-full border border-card-border bg-card/70 px-3 py-2 text-xs shadow-sm sm:flex">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isMarketOpen ? "bg-accent animate-pulse" : "bg-loss"
              )}
            />
            <span className={cn("font-bold", isMarketOpen ? "text-accent" : "text-loss")}>
              {isMarketOpen ? "Market Open" : "Market Closed"}
            </span>
            {clockStr && (
              <span className="hidden font-mono text-muted min-[1900px]:inline">{clockStr}</span>
            )}
          </div>

          <div className="hidden min-[1900px]:block">
            <ThemeModeButton isDark={isDark} toggleTheme={toggleTheme} />
          </div>

          {/* Guide link */}
          <Link
            href="/guide"
            className="hidden items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-accent min-[2200px]:flex"
            title="User Guide"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            Guide
          </Link>

          {/* Search icon */}
          <button
            onClick={() => {
              // If already on /stocks, dispatch event to switch tab
              if (window.location.pathname === "/stocks") {
                window.dispatchEvent(new CustomEvent("switch-to-all-stocks"));
              } else {
                router.push("/stocks?universe=all");
              }
            }}
            className="rounded-lg p-2 text-muted transition-colors hover:bg-surface-hover hover:text-foreground min-[1900px]:hidden"
            title="Search stocks"
            aria-label="Search stocks"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>

          <div className="min-[1900px]:hidden">
            <ThemeModeButton isDark={isDark} toggleTheme={toggleTheme} compact />
          </div>

          {/* Profile dropdown */}
          <div className="relative" ref={profileRef}>
            <button
              onClick={() => setProfileOpen(!profileOpen)}
              className="flex items-center gap-2 rounded-xl border border-accent/35 bg-accent-bg/35 p-1.5 shadow-sm transition-colors hover:border-accent/60 hover:bg-accent-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              aria-label="Open profile menu"
              aria-expanded={profileOpen}
              title="Open profile menu"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-accent/40 bg-accent/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
                <span className="text-xs font-black text-accent">
                  {user?.email?.[0]?.toUpperCase() || "U"}
                </span>
              </div>
              <svg
                className={cn("hidden h-3 w-3 text-muted transition-transform min-[1900px]:block", profileOpen && "rotate-180")}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {profileOpen && (
              <div className="absolute right-0 mt-2 w-64 bg-dropdown-bg border border-dropdown-border rounded-xl shadow-2xl overflow-hidden">
                {/* User info */}
                {user && (
                  <div className="px-4 py-3 border-b border-divider">
                    <p className="text-sm font-medium text-text-heading truncate">
                      {user.user_metadata?.full_name || user.email?.split("@")[0] || "User"}
                    </p>
                    <p className="text-xs text-text-secondary truncate">{user.email}</p>
                  </div>
                )}

                <div className="py-1">
                  <DropdownLink href="/settings" label="Settings" icon={settingsIcon} />
                  <DropdownLink href="/subscription" label="Subscription" icon={creditCardIcon} />
                  <DropdownLink href="/feedback" label="Feedback" icon={chatIcon} />
                  {isAdmin && (
                    <DropdownLink href="/alpha-login" label="Alpha Login" icon={shieldIcon} />
                  )}
                </div>

                <div className="border-t border-divider py-1">
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-loss hover:bg-loss-bg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="rounded-lg p-2 text-muted transition-colors hover:bg-surface-hover hover:text-foreground md:hidden"
          >
            {mobileMenuOpen ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-divider bg-nav-bg pb-3">
          <div className="flex flex-col px-3 pt-2 gap-0.5">
            {visibleTabs.map((tab) => {
              const active = isTabActive(pathname, tab.href, searchParams.get("tab"), tab.tradeTabs);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    "px-4 py-2.5 rounded-lg text-sm font-medium transition-colors",
                    active
                      ? "text-accent bg-accent-bg"
                      : "text-muted hover:text-foreground hover:bg-surface-hover"
                  )}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {tab.label}
                    {tab.premium && <PremiumBadge />}
                  </span>
                </Link>
              );
            })}
          </div>
          {/* Market status in mobile */}
          <div className="flex items-center gap-1.5 text-xs px-7 pt-3 sm:hidden">
            <span
              className={cn(
                "w-2 h-2 rounded-full",
                isMarketOpen ? "bg-accent animate-pulse" : "bg-loss"
              )}
            />
            <span className={isMarketOpen ? "text-accent" : "text-loss"}>
              {isMarketOpen ? "Market Open" : "Market Closed"}
            </span>
          </div>
        </div>
      )}
    </nav>
  );
}

// ── Dropdown link helper ─────────────────────────────────────────────────────

function DropdownLink({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-surface-hover transition-colors"
    >
      {icon}
      {label}
    </Link>
  );
}

// ── SVG Icons ────────────────────────────────────────────────────────────────

const settingsIcon = (
  <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const creditCardIcon = (
  <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
  </svg>
);

const chatIcon = (
  <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
);

const shieldIcon = (
  <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
  </svg>
);
