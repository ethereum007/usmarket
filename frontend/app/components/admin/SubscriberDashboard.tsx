"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

type MembershipStatus = "premium" | "free" | "expired";
type SubscriberFilter = "all" | MembershipStatus;
type SubscriberSort = "recent_activity" | "joined" | "valid_until" | "payment";

interface Member {
  id: string;
  name: string | null;
  email: string | null;
  mobile: string | null;
  joinedAt: string | null;
  lastSignInAt: string | null;
  membership: {
    plan: string;
    status: MembershipStatus;
    isExpired: boolean;
    validFrom: string | null;
    validUntil: string | null;
  };
  payment: {
    status: "paid" | "pending" | "complimentary" | "not_started";
    paidAt: string | null;
    amountPaise: number | null;
    paymentReference: string | null;
    orderReference: string | null;
  };
}

interface SubscriberResponse {
  summary: {
    totalUsers: number;
    activePremium: number;
    freeUsers: number;
    expiredPremium: number;
    loginsLast30Days: number;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  members: Member[];
  generatedAt: string;
  dataNote: string;
}

interface SubscriberDashboardProps {
  adminHeaders: Record<string, string>;
  hasAdminCredentials: boolean;
}

type SummaryCard = [label: string, value: number, valueClassName: string];

const STATUS_COPY: Record<MembershipStatus, string> = {
  premium: "Premium",
  free: "Free",
  expired: "Expired",
};

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Asia/Kolkata",
  });
}

function PaymentCell({ payment }: { payment: Member["payment"] }) {
  if (payment.status === "paid") {
    return (
      <div>
        <div className="font-semibold text-text-heading">₹999 · Paid</div>
        <div className="mt-0.5 text-[10px] text-text-secondary">{formatDate(payment.paidAt, true)}</div>
        {payment.paymentReference && (
          <div className="mt-1 font-mono text-[10px] text-text-tertiary">{payment.paymentReference}</div>
        )}
      </div>
    );
  }
  if (payment.status === "pending") return <span className="font-semibold text-warning">Payment pending</span>;
  if (payment.status === "complimentary") return <span className="text-text-secondary">Coupon / manual</span>;
  return <span className="text-text-tertiary">No payment</span>;
}

function StatusBadge({ status }: { status: MembershipStatus }) {
  const style =
    status === "premium"
      ? "border-accent/30 bg-accent/15 text-accent"
      : status === "expired"
        ? "border-loss/30 bg-loss/10 text-loss"
        : "border-card-border bg-surface-subtle text-text-secondary";
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold ${style}`}>{STATUS_COPY[status]}</span>;
}

export default function SubscriberDashboard({ adminHeaders, hasAdminCredentials }: SubscriberDashboardProps) {
  const [data, setData] = useState<SubscriberResponse | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SubscriberFilter>("all");
  const [sort, setSort] = useState<SubscriberSort>("recent_activity");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSubscribers = useCallback(async () => {
    if (!hasAdminCredentials) return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: "25", status: filter, sort });
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`${API_URL}/api/admin/subscribers?${params.toString()}`, { headers: adminHeaders });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.detail || "Could not load subscribers");
      setData(payload);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Could not load subscribers");
    } finally {
      setLoading(false);
    }
  }, [adminHeaders, filter, hasAdminCredentials, page, query, sort]);

  useEffect(() => {
    void loadSubscribers();
  }, [loadSubscribers]);

  const updateFilter = (nextFilter: SubscriberFilter) => {
    setFilter(nextFilter);
    setPage(1);
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(searchInput);
    setPage(1);
  };

  const exportSubscribers = async () => {
    if (!hasAdminCredentials || exporting) return;
    setExporting(true);
    setError(null);
    const params = new URLSearchParams({ status: filter, sort });
    if (query.trim()) params.set("q", query.trim());

    try {
      const response = await fetch(`${API_URL}/api/admin/subscribers/export?${params.toString()}`, {
        headers: adminHeaders,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail || "Could not create the Excel export");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "alpha-radar-members.xlsx";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Could not create the Excel export");
    } finally {
      setExporting(false);
    }
  };

  const summaryCards: SummaryCard[] = data
    ? [
        ["All users", data.summary.totalUsers, "text-text-heading"],
        ["Premium active", data.summary.activePremium, "text-accent"],
        ["Free", data.summary.freeUsers, "text-text-secondary"],
        ["Expired", data.summary.expiredPremium, "text-loss"],
        ["Signed in (30d)", data.summary.loginsLast30Days, "text-warning"],
      ]
    : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="m-0 text-xl font-extrabold text-text-heading">Subscribers</h2>
          <p className="mt-1 text-[13px] text-text-secondary">Alpha Radar members, subscription validity, latest payment, and sign-in activity.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void exportSubscribers()} disabled={exporting || loading || !data} className="inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-60">
            <Download size={14} aria-hidden="true" />
            {exporting ? "Preparing Excel…" : "Download Excel"}
          </button>
          <button type="button" onClick={() => void loadSubscribers()} disabled={loading} className="rounded-lg border border-card-border bg-surface-subtle px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-heading disabled:cursor-not-allowed disabled:opacity-60">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-loss/30 bg-loss-bg px-3.5 py-3 text-xs text-loss">{error}</div>}

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        {loading && !data
          ? Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-[86px] animate-pulse rounded-[10px] border border-card-border bg-surface-subtle" />
            ))
          : summaryCards.map((card) => (
            <div key={card[0]} className="rounded-[10px] border border-card-border bg-surface-subtle px-3.5 py-3">
              <div className="text-[9px] font-bold tracking-[1.15px] text-text-secondary">{card[0].toUpperCase()}</div>
              <div className={`mt-1 text-2xl font-extrabold ${card[2]}`}>{card[1]}</div>
            </div>
          ))}
      </div>

      <div className="rounded-xl border border-card-border bg-surface-subtle p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <form onSubmit={submitSearch} className="flex min-w-0 flex-1 gap-2">
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search email, name, or mobile" className="min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-3 py-2 text-[13px] text-text-heading outline-none placeholder:text-text-tertiary focus:border-accent/50" />
            <button className="rounded-md border border-card-border px-3 py-2 text-xs font-semibold text-text-secondary hover:text-text-heading" type="submit">Search</button>
          </form>
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", "premium", "free", "expired"] as const).map((item) => (
              <button key={item} type="button" onClick={() => updateFilter(item)} className={`rounded-md border px-3 py-[7px] text-[11px] font-semibold transition-colors ${filter === item ? "border-accent/30 bg-accent/15 text-accent" : "border-card-border bg-transparent text-text-secondary hover:text-text-heading"}`}>
                {item === "all" ? "All" : STATUS_COPY[item]}
              </button>
            ))}
            <select aria-label="Sort subscribers" value={sort} onChange={(event) => { setSort(event.target.value as SubscriberSort); setPage(1); }} className="rounded-md border border-input-border bg-input-bg px-2.5 py-[7px] text-[11px] font-semibold text-text-secondary outline-none">
              <option value="recent_activity">Recent sign-in</option>
              <option value="joined">Newest joined</option>
              <option value="valid_until">Validity date</option>
              <option value="payment">Latest payment</option>
            </select>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-card-border bg-surface-subtle">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] border-collapse text-left">
            <thead className="border-b border-card-border bg-surface-subtle text-[9px] font-bold tracking-[1px] text-text-tertiary">
              <tr>
                <th className="px-4 py-3">MEMBER</th><th className="px-4 py-3">CONTACT</th><th className="px-4 py-3">MEMBERSHIP</th><th className="px-4 py-3">LATEST PAYMENT</th><th className="px-4 py-3">VALID UNTIL</th><th className="px-4 py-3">LAST SIGN-IN</th><th className="px-4 py-3">JOINED</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-text-tertiary">Loading subscribers…</td></tr>}
              {!loading && data?.members.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-text-tertiary">No subscribers match this view.</td></tr>}
              {data?.members.map((member, index) => (
                <tr key={member.id} className={`border-b border-card-border/50 text-xs ${index % 2 === 0 ? "bg-stripe-bg" : "bg-transparent"}`}>
                  <td className="px-4 py-3.5"><div className="font-bold text-text-heading">{member.name || "Unnamed member"}</div><div className="mt-1 text-[11px] text-text-secondary">{member.email || "No email"}</div></td>
                  <td className="px-4 py-3.5 text-text-secondary">{member.mobile || "—"}</td>
                  <td className="px-4 py-3.5"><StatusBadge status={member.membership.status} /><div className="mt-1.5 text-[10px] text-text-secondary">{member.membership.plan.toUpperCase()}</div></td>
                  <td className="px-4 py-3.5 text-[11px]"><PaymentCell payment={member.payment} /></td>
                  <td className="px-4 py-3.5 text-[11px] text-text-secondary">{formatDate(member.membership.validUntil)}</td>
                  <td className="px-4 py-3.5 text-[11px] text-text-secondary">{formatDate(member.lastSignInAt, true)}</td>
                  <td className="px-4 py-3.5 text-[11px] text-text-secondary">{formatDate(member.joinedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && (
          <div className="flex flex-col gap-3 border-t border-card-border px-4 py-3 text-[11px] text-text-secondary sm:flex-row sm:items-center sm:justify-between">
            <span>Showing {data.members.length ? (data.pagination.page - 1) * data.pagination.limit + 1 : 0}–{Math.min(data.pagination.page * data.pagination.limit, data.pagination.total)} of {data.pagination.total}</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={data.pagination.page === 1 || loading} className="rounded-md border border-card-border px-2.5 py-1.5 font-semibold disabled:cursor-not-allowed disabled:opacity-50 hover:text-text-heading">Previous</button>
              <span>Page {data.pagination.page} / {data.pagination.totalPages}</span>
              <button type="button" onClick={() => setPage((current) => Math.min(data.pagination.totalPages, current + 1))} disabled={data.pagination.page >= data.pagination.totalPages || loading} className="rounded-md border border-card-border px-2.5 py-1.5 font-semibold disabled:cursor-not-allowed disabled:opacity-50 hover:text-text-heading">Next</button>
            </div>
          </div>
        )}
      </div>

      {data && <p className="m-0 text-[11px] leading-relaxed text-text-tertiary">Updated {formatDate(data.generatedAt, true)} IST. {data.dataNote}</p>}
    </div>
  );
}
