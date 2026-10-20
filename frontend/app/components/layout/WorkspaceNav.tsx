"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUpRight, ChevronDown, ChevronsUpDown, CreditCard, LogIn, LogOut, Moon, Radar, Search, Settings2, Sun, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../lib/theme";
import { PremiumBadge } from "../premium/PremiumBadge";
import { WORKSPACE_GROUPS, SUPPORT_LINKS, linkIsActive } from "./navigation";

const ADMIN_EMAILS = ["charan@trezofin.ai", "balaji.kdutta@gmail.com"];

export function Brand() {
  return <Link href="/" className="brand" aria-label="Alpha Radar home">
    <span className="brand-mark"><Radar size={22} strokeWidth={1.7} aria-hidden="true" /></span>
    <span><span className="block text-[17px] font-semibold tracking-tight text-text-heading">Alpha<span className="text-accent">Radar</span></span><span className="brand-tagline block text-[10px] font-medium tracking-[0.16em] text-muted uppercase">The trading workspace</span></span>
  </Link>;
}

export function WorkspaceNav() {
  const pathname = usePathname();
  const params = useSearchParams();
  const routeTab = params.get("tab");
  const isUSResearch = pathname === "/us" || pathname.startsWith("/us/");
  const router = useRouter();
  const { user, subscription, signOut } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [compact, setCompact] = useState(false);
  const [clock, setClock] = useState("");
  const [sessionHours, setSessionHours] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [menuLeft, setMenuLeft] = useState(14);
  const [searchOpen, setSearchOpen] = useState(false);
  const profile = useRef<HTMLDivElement>(null);
  const profileButton = useRef<HTMLButtonElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const header = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const groupButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const panels = useRef<Record<string, HTMLElement | null>>({});
  const isAdmin = !!user && ADMIN_EMAILS.includes(user.email?.toLowerCase() || "");
  const groups = [...WORKSPACE_GROUPS, { label: "Help", links: [...SUPPORT_LINKS, { href: "/subscription", label: subscription?.is_active ? "Your Premium plan" : "Explore Premium", icon: CreditCard }] }]
    .map(group => ({ ...group, links: group.links.filter(link => !link.admin || isAdmin) }))
    .filter(group => group.links.length > 0);
  const routeGroup = groups.find(group => group.links.some(link => linkIsActive(link, pathname, routeTab)))?.label
    || (pathname === "/radar-trade" ? "Discover" : ["/settings", "/subscription"].includes(pathname) ? "Help" : "Market");

  useEffect(() => {
    try { setCompact(localStorage.getItem("alpha-density") === "compact"); } catch { /* Storage may be unavailable. */ }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.density = compact ? "compact" : "comfortable";
    try { localStorage.setItem("alpha-density", compact ? "compact" : "comfortable"); } catch { /* Preference remains in memory. */ }
  }, [compact]);
  useEffect(() => {
    function tick() {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: isUSResearch ? "America/New_York" : "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
      const part = (type: string) => parts.find(p => p.type === type)?.value || "";
      const minutes = Number(part("hour")) * 60 + Number(part("minute"));
      setClock(`${part("hour")}:${part("minute")} ${isUSResearch ? "ET" : "IST"}`);
      setSessionHours(!isUSResearch && !["Sat", "Sun"].includes(part("weekday")) && minutes >= 555 && minutes < 930);
    }
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [isUSResearch]);
  useEffect(() => {
    function onPointer(event: PointerEvent) {
      if (profile.current && !profile.current.contains(event.target as Node)) setProfileOpen(false);
      if (openGroup && !navigation.current?.contains(event.target as Node) && !panels.current[openGroup]?.contains(event.target as Node)) setOpenGroup(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (profileOpen) { setProfileOpen(false); profileButton.current?.focus(); }
        else if (searchOpen) { setSearchOpen(false); searchButton.current?.focus(); }
        else if (openGroup) { setOpenGroup(null); groupButtons.current[openGroup]?.focus(); }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setSearchOpen(true); searchInput.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [profileOpen, searchOpen, openGroup]);
  useEffect(() => {
    setOpenGroup(null); setProfileOpen(false); setSearchOpen(false);
  }, [pathname, routeTab]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const symbol = query.trim().toUpperCase();
    router.push(symbol ? `/stocks?symbol=${encodeURIComponent(symbol)}&universe=all` : "/stocks?universe=all");
    setQuery(""); setSearchOpen(false);
  }
  function showGroup(label: string, button: HTMLButtonElement) {
    const bounds = header.current?.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    if (bounds) setMenuLeft(Math.max(14, Math.min(buttonBounds.left - bounds.left, bounds.width - 294)));
    setOpenGroup(label);
  }
  function onGroupKey(event: ReactKeyboardEvent<HTMLButtonElement>, label: string) {
    const index = groups.findIndex(group => group.label === label);
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % groups.length
      : event.key === "ArrowLeft" ? (index + groups.length - 1) % groups.length
      : event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1 : -1;
    if (nextIndex >= 0) {
      event.preventDefault(); setOpenGroup(null); groupButtons.current[groups[nextIndex].label]?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault(); showGroup(label, event.currentTarget);
      requestAnimationFrame(() => panels.current[label]?.querySelector("a")?.focus());
    }
  }

  return <header ref={header} className="workspace-header"
    onBlur={event => {
      if (!navigation.current?.contains(event.relatedTarget) && !panels.current[openGroup || ""]?.contains(event.relatedTarget)) setOpenGroup(null);
    }}>
    <div className="workspace-topbar">
      <Brand />
      <nav ref={navigation} className="workspace-groups" aria-label="Workspace sections">
        {groups.map(group => <button key={group.label} ref={element => { groupButtons.current[group.label] = element; }}
          id={`workspace-group-${group.label.toLowerCase()}`} type="button"
          className={cn("workspace-group-button", openGroup === group.label && "is-open", routeGroup === group.label && "is-current")}
          aria-expanded={openGroup === group.label} aria-controls={`workspace-subnav-${group.label.toLowerCase()}`}
          onClick={event => openGroup === group.label ? setOpenGroup(null) : showGroup(group.label, event.currentTarget)}
          onKeyDown={event => onGroupKey(event, group.label)}>
          {group.label}<ChevronDown size={13} aria-hidden="true" />
        </button>)}
      </nav>
      <form onSubmit={search} className={cn("workspace-search", searchOpen && "is-open")} role="search" id="workspace-search">
        <Search size={16} aria-hidden="true" /><input ref={searchInput} aria-label="Search stocks" placeholder="Search any stock…" value={query} onChange={e => setQuery(e.target.value)} /><kbd>Ctrl K</kbd>
        <button type="button" className="icon-button search-close" aria-label="Close stock search" onClick={() => { setSearchOpen(false); searchButton.current?.focus(); }}><X size={18} /></button>
      </form>
      <div className="topbar-actions">
        <div className="session-clock" title={isUSResearch ? "New York time; research uses saved completed sessions." : "Scheduled NSE hours in IST; exchange holidays and feed status may differ."}><span className={cn("h-1.5 w-1.5 rounded-full", sessionHours ? "bg-profit" : "bg-muted")} /><span>{isUSResearch ? "New York" : sessionHours ? "Session hours" : "Outside session"}</span><span className="font-mono text-text-heading">{clock || (isUSResearch ? "— ET" : "— IST")}</span></div>
        <Link href="/subscription" className="workspace-plan-link" aria-current={pathname === "/subscription" ? "page" : undefined}><span>{subscription?.is_active ? "Your Premium plan" : "Explore Premium"}</span><ArrowUpRight size={15} aria-hidden="true" /></Link>
        <button ref={searchButton} className="icon-button search-toggle" aria-label="Open stock search" aria-expanded={searchOpen} aria-controls="workspace-search" onClick={() => setSearchOpen(!searchOpen)}><Search size={18} /></button>
        <button className={cn("icon-button density-toggle", compact && "text-accent")} onClick={() => setCompact(!compact)} aria-label={compact ? "Use comfortable table density" : "Use compact table density"} aria-pressed={compact} title={compact ? "Comfortable table density" : "Compact table density"}><ChevronsUpDown size={18} /></button>
        <button className="icon-button" onClick={toggleTheme} aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"} title={isDark ? "Light mode" : "Dark mode"}>{isDark ? <Sun size={18} /> : <Moon size={18} />}</button>
        <div className="relative" ref={profile}>
          <button ref={profileButton} onClick={() => setProfileOpen(!profileOpen)} className="profile-button" aria-label="Account menu" aria-expanded={profileOpen} aria-controls="account-menu"><span className="profile-avatar">{user?.email?.[0]?.toUpperCase() || "AR"}</span><ChevronDown size={13} className="hidden sm:block text-muted" /></button>
          {profileOpen && <div id="account-menu" className="account-menu">
            <div className="border-b border-divider px-4 py-3"><p className="text-sm font-semibold text-text-heading">{user?.user_metadata?.full_name || (user ? "Your account" : "Welcome to Alpha Radar")}</p><p className="mt-1 truncate text-xs text-muted">{user?.email || "Your next opportunity starts here."}</p></div>
            {user ? <><Link href="/settings"><Settings2 size={16} />Settings</Link><Link href="/subscription"><CreditCard size={16} />Subscription</Link><button onClick={async () => { await signOut(); setProfileOpen(false); router.push("/login"); }}><LogOut size={16} />Sign out</button></> : <><Link href="/login"><LogIn size={16} />Sign in</Link><Link href="/signup"><ArrowUpRight size={16} />Create an account</Link></>}
          </div>}
        </div>
      </div>
    </div>
    {groups.map(group => <nav key={group.label} ref={element => { panels.current[group.label] = element; }}
          id={`workspace-subnav-${group.label.toLowerCase()}`} className="workspace-subnav" aria-label={`${group.label} pages`} aria-labelledby={`workspace-group-${group.label.toLowerCase()}`}
          style={{ left: menuLeft }} hidden={openGroup !== group.label}>
          <p className="workspace-subnav-heading">{group.label} pages</p>
          {group.links.map(link => {
            const active = linkIsActive(link, pathname, routeTab);
            return <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}
              aria-label={link.premium ? `${link.label}, Premium` : undefined}
              className={cn("workspace-subnav-link", active && "is-active")} onClick={() => setOpenGroup(null)}>
              <link.icon size={16} strokeWidth={1.7} aria-hidden="true" /><span>{link.label}</span>
              {link.premium && <PremiumBadge className="ml-auto shrink-0" />}
            </Link>;
          })}
        </nav>)}
  </header>;
}
