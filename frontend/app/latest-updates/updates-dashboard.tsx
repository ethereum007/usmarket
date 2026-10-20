"use client";

import { PageHeader } from "../components/layout/PageHeader";
import AnnouncementTable from "./announcement-table";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ArrowUpRight, Building2, FileText, RefreshCw, Search } from "lucide-react";
import { Announcement, EVENT_TYPES, EventType, breakdown, istDate } from "./model";
import { comparePriority, reviewPriority, type ReviewPriority } from "./priority";

type Props = { rows: Announcement[]; date: string; today: string; latestAt: string | null; limited: boolean; error: boolean };
const dateLabel = (value: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00+05:30`));
const timeLabel = (value: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export default function UpdatesDashboard({ rows, date, today, latestAt, limited, error }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<EventType | "all">("all");
  const [visible, setVisible] = useState(24);
  const [priority, setPriority] = useState<"focus" | "all" | ReviewPriority["level"]>("focus");
  const [sort, setSort] = useState<"priority" | "latest">("priority");
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const interval = setInterval(() => { if (document.visibilityState === "visible") startTransition(() => router.refresh()); }, 300000);
    return () => clearInterval(interval);
  }, [router]);
  const matching = rows.filter(row => `${row.symbol} ${row.company_name || ""} ${row.headline}`.toLowerCase().includes(query.trim().toLowerCase()));
  const filtered = matching.filter(row => (type === "all" || row.event_type === type) && (priority === "all" || (priority === "focus" ? reviewPriority(row).level !== "low" : reviewPriority(row).level === priority))).sort(sort === "priority" ? comparePriority : (a, b) => b.event_date.localeCompare(a.event_date));
  const mix = breakdown(matching);
  const companies = new Set(rows.map(row => row.symbol)).size;
  let position = 0;
  const gradient = mix.map(item => {
    const start = position;
    position += item.count / matching.length * 100;
    return `${item.color} ${start}% ${position}%`;
  }).join(",");
  const selectType = (next: EventType | "all") => { setType(next); setVisible(24); };

  return <div className="mx-auto max-w-[1440px] space-y-6 pb-10">
    <PageHeader eyebrow="Corporate intelligence" title="Announcement priorities" description="Review the most important developments first. Positive and negative events are ranked by business impact and evidence, with daily price setups and the original NSE filing." />

    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-xl font-semibold text-text-heading">The announcement desk</h2>
        <p className="mt-1 text-xs text-muted">{dateLabel(date)} · All times IST{date < today ? " · Historical announcements" : ""}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="announcement-date">Announcement date</label>
        <input id="announcement-date" aria-label="Announcement date" type="date" value={date} max={today} onChange={event => { if (event.target.value) { setVisible(24); startTransition(() => router.push(`/latest-updates?date=${encodeURIComponent(event.target.value)}`)); } }} className="rounded-lg border border-card-border bg-card px-3 py-2 text-sm" />
        <button onClick={() => { setVisible(24); startTransition(() => router.push("/latest-updates")); }} className="rounded-lg border border-card-border bg-card px-3 py-2 text-sm hover:border-accent">Latest day</button>
        <button aria-label="Refresh announcements" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="rounded-lg border border-card-border bg-card p-2.5 hover:border-accent disabled:opacity-50"><RefreshCw size={16} className={pending ? "animate-spin" : ""} /></button>
      </div>
    </div>
    {error ? <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 p-5 text-sm">The NSE announcement feed is temporarily unavailable. Please use Refresh to try again.</div> : null}
    {latestAt ? <p className="text-xs text-muted">Latest source announcement: {dateLabel(istDate(latestAt))}, {timeLabel(latestAt)} IST. The page checks for updates every 5 minutes.</p> : null}
    {limited ? <p className="text-xs text-warning">Showing the latest 1,000 announcements for this date. Counts and chart cover these loaded announcements only.</p> : null}
    <div className="grid gap-3 sm:grid-cols-3">
      {[{ label: "Announcements", value: rows.length, icon: FileText }, { label: "Companies in focus", value: companies, icon: Building2 }, { label: "Order wins", value: rows.filter(row => row.event_type === "order_win").length, icon: ArrowUpRight }].map(({ label, value, icon: Icon }) => <div key={label} className="flex items-center gap-4 rounded-xl border border-card-border bg-card px-5 py-4"><div className="rounded-lg bg-accent/10 p-3 text-accent"><Icon size={20} /></div><div><p className="text-xs text-muted">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums text-text-heading">{error ? "—" : value}</p></div></div>)}
    </div>

    <div className="space-y-6">
      <section className="min-w-0" aria-label="Announcement feed" aria-busy={pending}>
        <label className="mb-4 flex items-center gap-3 rounded-xl border border-card-border bg-card px-4 py-3"><Search size={17} className="text-muted" /><span className="sr-only">Search announcements</span><input value={query} onChange={event => { setQuery(event.target.value); setVisible(24); }} placeholder="Search company, symbol or announcement…" className="w-full bg-transparent text-sm outline-none" /></label>
        <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Review priority">
          {([ ["focus", "Review first"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["all", "All news"] ] as const).map(([value, label]) => <button key={value} aria-pressed={priority === value} onClick={() => { setPriority(value); setVisible(24); }} className={`rounded-lg border px-3 py-2 text-xs ${priority === value ? "border-accent bg-accent/10 text-accent" : "border-card-border text-muted"}`}>{label}{value === "high" || value === "medium" || value === "low" ? ` (${matching.filter(row => reviewPriority(row).level === value).length})` : ""}</button>)}
          <label className="ml-auto text-xs text-muted">Sort <select value={sort} onChange={event => { setSort(event.target.value as "priority" | "latest"); setVisible(24); }} className="ml-2 rounded-lg border border-card-border bg-card px-2 py-2"><option value="priority">Priority first</option><option value="latest">Newest first</option></select></label>
        </div>
        <p className="mb-4 text-xs leading-5 text-muted">High: substantial impact with supporting evidence. Medium: worth checking. Low: limited impact or repeated news. Ratings are provisional; company-relative size and urgency still need verification. Priority means review order, not a buy or sell call.</p>
        <div className="mb-5 flex flex-wrap gap-2" aria-label="Announcement categories">
          <button aria-pressed={type === "all"} onClick={() => selectType("all")} className={`rounded-full border px-3 py-1.5 text-xs ${type === "all" ? "border-accent bg-accent/10 text-accent" : "border-card-border text-muted"}`}>All updates</button>
          {Object.entries(EVENT_TYPES).map(([key, item]) => <button key={key} aria-pressed={type === key} onClick={() => selectType(key as EventType)} className={`rounded-full border px-3 py-1.5 text-xs ${type === key ? "border-accent bg-accent/10 text-accent" : "border-card-border text-muted hover:text-foreground"}`}>{item.label}</button>)}
        </div>
        <p aria-live="polite" className="mb-3 text-xs text-muted">{filtered.length} matching announcements{priority === "focus" ? " · Low priority news hidden; select All news to see it." : ""}</p>
        {filtered.length === 0 ? <div className="rounded-xl border border-dashed border-card-border p-12 text-center"><FileText className="mx-auto mb-3 text-muted" /><h3 className="text-sm font-semibold text-text-heading">{error ? "Feed unavailable" : "No announcements found"}</h3><p className="mt-2 text-xs text-muted">{error ? "Refresh to reconnect to the source." : "Try another date, category or search."}</p></div> : <AnnouncementTable rows={filtered.slice(0, visible)} date={date} />}
        {filtered.length > visible ? <button onClick={() => setVisible(count => count + 24)} className="mt-5 w-full rounded-xl border border-card-border bg-card py-3 text-sm hover:border-accent">Show more updates ({filtered.length - visible} remaining)</button> : null}
      </section>

      <details className="rounded-xl border border-card-border bg-card p-6"><summary className="cursor-pointer text-sm font-semibold text-text-heading">Announcement mix by event type</summary>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">The day&apos;s composition</p>
        <h2 className="mt-2 text-lg font-semibold text-text-heading">Announcement mix</h2>
        <p className="mt-2 text-xs leading-5 text-muted">Share of announcements by event type{query.trim() ? " matching your search" : ""}. Select a category to explore.</p>
        <div className="relative mx-auto my-7 h-48 w-48 rounded-full" role="img" aria-label={mix.length ? mix.map(item => `${item.label}: ${item.count} (${(item.count / matching.length * 100).toFixed(1)}%)`).join(", ") : "No announcement data to chart"} style={{ background: gradient ? `conic-gradient(${gradient})` : "var(--card-border)" }}>
          <div className="absolute inset-7 flex flex-col items-center justify-center rounded-full bg-card"><span className="text-3xl font-semibold tabular-nums text-text-heading">{error ? "—" : matching.length}</span><span className="mt-1 text-[10px] uppercase tracking-wider text-muted">Updates</span></div>
        </div>
        <div className="space-y-1">{mix.map(item => <button key={item.type} onClick={() => selectType(type === item.type ? "all" : item.type)} aria-pressed={type === item.type} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent/10 ${type === item.type ? "bg-accent/10" : ""}`}><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} /><span className="flex-1">{item.label}</span><span className="text-muted">{item.count}</span><span className="w-10 text-right font-semibold tabular-nums">{Math.round(item.count / matching.length * 100)}%</span></button>)}</div>
        <p className="mt-5 border-t border-card-border pt-4 text-[11px] leading-5 text-muted">Counts represent announcements, not portfolio allocations or investment recommendations. One company can have multiple filings.</p>
      </details>
    </div>
  </div>;
}
