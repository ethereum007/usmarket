"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Globe2, Search, Sun, Moon } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../lib/theme";
import "./us-workspace.css";

export function USWorkspaceNav() {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  async function leave() {
    setSigningOut(true);
    setSignOutError(false);
    try {
      await signOut();
      router.replace("/us/login");
    } catch {
      setSignOutError(true);
    } finally {
      setSigningOut(false);
    }
  }
  const pathname = usePathname();
  const router = useRouter();
  const { isDark, toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [clock, setClock] = useState("");
  useEffect(() => {
    function tick() {
      setClock(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date()) + " ET",
      );
    }
    tick();
    const timer = setInterval(tick, 30000);
    return () => clearInterval(timer);
  }, []);
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const symbol = query.trim().toUpperCase();
    router.push(
      symbol
        ? `/us?symbol=${encodeURIComponent(symbol)}#research-queue`
        : "/us#research-queue",
    );
    setQuery("");
  }
  return (
    <header className="us-workspace-header">
      <div className="us-workspace-top">
        <Link
          href="/us"
          className="us-workspace-brand"
          aria-label="Alpha Radar US home"
        >
          <span className="us-workspace-mark">
            <Globe2 size={23} />
          </span>
          <span>
            <strong>
              Alpha<span>Radar</span>
              <b>US</b>
            </strong>
            <small>U.S. EQUITY RESEARCH</small>
          </span>
        </Link>
        <nav aria-label="US workspace navigation">
          <Link href="/us#market-context">Market</Link>
          <Link href="/us#live-data">Live tape</Link>
          <Link href="/us#research-queue">Research</Link>
          <Link href="/us?view=shortlist#research-queue">Shortlist</Link>
          <Link href="/us#us-plans">Plans</Link>
          <Link
            href="/us/guide"
            aria-current={pathname === "/us/guide" ? "page" : undefined}
          >
            Guide
          </Link>
        </nav>
        <form role="search" onSubmit={search} className="us-workspace-search">
          <Search size={15} />
          <input
            aria-label="Search US stock symbols"
            placeholder="US symbol: AAPL, NVDA…"
            pattern="[A-Za-z][A-Za-z0-9.\-]{0,14}"
            maxLength={15}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" aria-label="Find US stock">
            Go
          </button>
        </form>
        <div className="us-workspace-tools">
          <button type="button" disabled={signingOut} onClick={() => void leave()}>{signingOut ? "Signing out…" : "Sign out"}</button>
          {signOutError && <span role="alert">Sign-out failed. Retry.</span>}
          <span title="America/New_York; adjusts for daylight saving">
            New York <strong>{clock || "— ET"}</strong>
          </span>
          <button
            onClick={toggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </div>
      <div className="us-workspace-strip">
        <span>UNITED STATES</span>
        <span>USD</span>
        <span>SPY / QQQ benchmarks</span>
        <span>Alpaca market data</span>
        <Link href="/us#us-refresh">Manage US universe →</Link>
      </div>
    </header>
  );
}
