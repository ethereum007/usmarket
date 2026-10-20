"use client";
import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronRight,
  Download,
  Globe2,
  RefreshCw,
  Search,
} from "lucide-react";
import { fetchAPI, postAPI } from "../lib/api";
import { useTheme } from "../lib/theme";
import { weeklyBars } from "../lib/swing-research";
import {
  type USPackage,
  type USSummary,
  usd,
  metric,
  signed,
} from "../lib/us-research";
import "./us.css";
import LiveFeed from "./live-feed";
import USPlans from "./plans";
import { useAuth } from "../contexts/AuthContext";
const Chart = dynamic(
  () =>
    import("../components/charts/CandlestickChart").then(
      (m) => m.CandlestickChart,
    ),
  { ssr: false },
);
const ROOT = "/api/us/research";
const STORAGE = "alpha-us-research-notes-v1";
type Notes = Record<string, { note: string; saved: boolean }>;
type Job = { id: string; state: string; error?: string; package_id?: string };

function USResearchContent() {
  const { user } = useAuth();
  const params = useSearchParams();
  const requestedSymbol = (params.get("symbol") || "").trim().toUpperCase();
  const requestedView = params.get("view") || "";
  const { theme } = useTheme();
  const [packages, setPackages] = useState<USSummary[]>([]);
  const [data, setData] = useState<USPackage | null>(null);
  const [packageId, setPackageId] = useState("");
  const [symbol, setSymbol] = useState("");
  const [strategy, setStrategy] = useState("");
  const [timeframe, setTimeframe] = useState("daily");
  const [search, setSearch] = useState("");
  const [onlySaved, setOnlySaved] = useState(false);
  const [notes, setNotes] = useState<Notes>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState<Job | null>(null);
  const [draftSymbols, setDraftSymbols] = useState("");
  const [benchmark, setBenchmark] = useState("SPY");
  const [sort, setSort] = useState("rs20");

  useEffect(() => {
    if (requestedSymbol && data) {
      setOnlySaved(false);
      setSearch(data.symbols.includes(requestedSymbol) ? "" : requestedSymbol);
      if (data.symbols.includes(requestedSymbol)) {
        setSymbol(requestedSymbol);
        setStrategy("");
      }
    }
  }, [requestedSymbol, data]);
  useEffect(() => {
    setOnlySaved(requestedView === "shortlist");
  }, [requestedView]);

  const loadCatalog = useCallback(async (selectNewest = false) => {
    const result = await fetchAPI<{
      packages: USSummary[];
      default_symbols: string;
    }>(`${ROOT}/packages`);
    setPackages(result.packages);
    setDraftSymbols((previous) => previous || result.default_symbols);
    {
      const chosen =
        result.packages.find(
          (p) => p.state === "final" && p.symbols.length >= 20,
        ) ||
        result.packages.find((p) => p.state === "final") ||
        result.packages[0];
      setPackageId((previous) =>
        selectNewest || !previous ? chosen?.id || "" : previous,
      );
    }
  }, []);

  useEffect(() => {
    let active = true;
    loadCatalog()
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [loadCatalog]);
  useEffect(() => {
    if (!packageId) return;
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    fetchAPI<{ package: USPackage }>(`${ROOT}/packages/${packageId}`)
      .then((r) => {
        if (active) {
          setData(r.package);
          setSymbol(r.package.symbols[0] || "");
          setStrategy("");
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [packageId]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        setNotes(
          Object.fromEntries(
            Object.entries(saved).filter(
              ([key, value]) =>
                /^[A-Z][A-Z0-9.\-]{0,14}$/.test(key) &&
                value &&
                typeof value === "object" &&
                typeof (value as Notes[string]).note === "string" &&
                typeof (value as Notes[string]).saved === "boolean",
            ),
          ) as Notes,
        );
    } catch {
      setStorageError("Browser notes could not be loaded.");
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(notes));
    } catch {
      setStorageError(
        "Browser storage is unavailable; notes have not been saved.",
      );
    }
  }, [notes, ready]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.state)) return;
    const timer = setTimeout(() => {
      fetchAPI<{ job: Job }>(`${ROOT}/jobs/${job.id}`)
        .then(async (r) => {
          setJob(r.job);
          if (r.job.state === "completed") {
            await loadCatalog();
            if (r.job.package_id) setPackageId(r.job.package_id);
          }
        })
        .catch((e) => {
          setJob({ ...job, state: "failed", error: e.message });
        });
    }, 2500);
    return () => clearTimeout(timer);
  }, [job, loadCatalog]);

  const queue = useMemo(() => {
    if (!data) return [];
    return data.symbols
      .filter(
        (s) =>
          s.toLowerCase().includes(search.toLowerCase()) &&
          (!onlySaved || notes[s]?.saved),
      )
      .sort((a, b) => {
        if (sort === "symbol") return a.localeCompare(b);
        const field = sort as "rs20" | "return1" | "rvol20";
        return (
          (data.features[b]?.[field] ?? -Infinity) -
            (data.features[a]?.[field] ?? -Infinity) || a.localeCompare(b)
        );
      });
  }, [data, search, onlySaved, notes, sort]);
  const setups = data?.setups.filter((s) => s.symbol === symbol) || [];
  const selected =
    setups.find((s) => s.setup_version === strategy) || setups[0];
  const thesisReasons = selected && data ? [
    ...selected.reasons.filter(reason => !/^(Nifty 500|NIFTY 500|SPY|QQQ) RS (20|60)D /.test(reason)),
    ...([20,60] as const).map(period => {
      const value = period === 20 ? selected.benchmark_rs_20 : selected.benchmark_rs_60;
      return value == null ? `${data.benchmark} RS ${period}D unavailable` : `${data.benchmark} RS ${period}D ${signed(value)} pp`;
    }),
  ] : [];
  const feature = data?.features[symbol];
  const bars = data?.source_bars[symbol] || [];
  const displayedBars = timeframe === "weekly" ? weeklyBars(bars) : bars;
  const note = notes[symbol]?.note || "";
  const busy = job && ["queued", "running"].includes(job.state);
  const levels = selected
    ? [
        {
          price: selected.entry_price,
          title: "Conditional entry",
          color: "#60a5fa",
        },
        { price: selected.stop_loss, title: "Invalidation", color: "#fb7185" },
      ].filter((l) => Number.isFinite(l.price) && l.price > 0)
    : [];
  function updateNote(update: Partial<Notes[string]>) {
    setNotes((n) => ({
      ...n,
      [symbol]: {
        note: n[symbol]?.note || "",
        saved: n[symbol]?.saved || false,
        ...update,
      },
    }));
  }
  async function refresh() {
    setError("");
    try {
      const result = await postAPI<{ job: Job }>(`${ROOT}/refresh`, {
        symbols: draftSymbols,
        benchmark,
        feed: "sip",
      });
      setJob(result.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    }
  }
  function exportResearch() {
    if (!data) return;
    const blob = new Blob(
      [JSON.stringify({ package: data, browser_notes: notes }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alpha-us-${data.session}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="us-terminal">
      <header className="us-heading">
        <div>
          <div className="us-eyebrow">
            <Globe2 size={14} /> ALPHA RADAR / UNITED STATES
          </div>
          <h1>
            Find strength.<span> Build conviction.</span>
          </h1>
          <p>
            Completed-session research, from market context to your next
            watchlist.
          </p>
        </div>
        <div className="us-heading-actions">
          <button onClick={exportResearch} disabled={!data}>
            <Download size={15} /> Export research
          </button>
          <a href="#us-refresh">
            <RefreshCw size={15} /> Update universe
          </a>
        </div>
      </header>
      <div className="us-session">
        <span className="us-dot" />
        <strong>{data ? `Session ${data.session}` : "US research"}</strong>
        <span>
          {data
            ? `${data.feed.toUpperCase()} · Split-adjusted · USD`
            : "Loading saved research"}
        </span>
        <span className="us-session-tag">After-close research</span>
        <label className="us-session-select">
          Saved package
          <select
            aria-label="Saved research package"
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
          >
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.session} · {p.symbols.length} stocks · {p.benchmark} ·{" "}
                {p.state}
              </option>
            ))}
          </select>
        </label>
      </div>
      {requestedSymbol && data && !data.symbols.includes(requestedSymbol) && (
        <p className="us-search-notice" role="status">
          {requestedSymbol} is not in this saved US universe. Add it in{" "}
          <a href="#us-refresh">Manage US universe</a> and refresh research to
          load its data.
        </p>
      )}
      <LiveFeed symbol={symbol} benchmark={data?.benchmark || "SPY"} />
      {error && (
        <div role="alert" className="us-error">
          {error}
          <button
            onClick={() =>
              void loadCatalog(true).catch((e) => setError(e.message))
            }
          >
            Retry
          </button>
        </div>
      )}
      {loading && (
        <p className="us-loading" role="status">
          Loading source research…
        </p>
      )}
      {data && (
        <>
          <section
            id="market-context"
            className="us-stats"
            aria-label="Market context"
          >
            <div>
              <span>Universe coverage</span>
              <strong>
                {data.breadth.available}
                <small> / {data.breadth.requested}</small>
              </strong>
              <p>Custom stock list · {data.state}</p>
            </div>
            <div>
              <span>Advancing stocks</span>
              <strong className="us-positive">
                {metric(data.breadth.advance_pct, 0)}
                <small>%</small>
              </strong>
              <p>
                {data.breadth.advances} advancing / {data.breadth.declines}{" "}
                declining
              </p>
            </div>
            <div>
              <span>Above 50-day EMA</span>
              <strong>
                {metric(
                  data.breadth.gauges.find((g) => g.label === "50 EMA")?.value,
                  0,
                )}
                <small>%</small>
              </strong>
              <p>
                {data.breadth.gauges.find((g) => g.label === "50 EMA")
                  ?.eligible || 0}{" "}
                eligible stocks
              </p>
            </div>
            <div>
              <span>Detected setups</span>
              <strong>
                {data.setups.length}
                <ArrowUpRight size={22} />
              </strong>
              <p>
                Across {new Set(data.setups.map((s) => s.symbol)).size} stocks ·
                thresholds uncalibrated
              </p>
            </div>
          </section>
          <div className="us-workspace">
            <section id="research-queue" className="us-panel us-queue">
              <div className="us-panel-title">
                <div>
                  <span className="us-eyebrow">01 / DISCOVER</span>
                  <h2>Research queue</h2>
                </div>
                <span className="us-count">{queue.length}</span>
              </div>
              <div className="us-search">
                <Search size={16} />
                <input
                  aria-label="Search US stocks"
                  placeholder="Find a symbol…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="us-queue-filters">
                <button
                  aria-pressed={!onlySaved}
                  onClick={() => setOnlySaved(false)}
                >
                  All stocks
                </button>
                <button
                  aria-pressed={onlySaved}
                  onClick={() => setOnlySaved(true)}
                >
                  Shortlist
                </button>
                <select
                  aria-label="Sort research queue"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="rs20">RS 20 ↓</option>
                  <option value="return1">Day % ↓</option>
                  <option value="rvol20">Volume ↓</option>
                  <option value="symbol">A–Z</option>
                </select>
              </div>
              <div className="us-table-label">
                <span>SYMBOL / SETUPS</span>
                <span>RS 20 pp / DAY %</span>
              </div>
              <div className="us-stock-list">
                {queue.map((s) => {
                  const f = data.features[s];
                  const count = data.setups.filter(
                    (x) => x.symbol === s,
                  ).length;
                  return (
                    <button
                      key={s}
                      className={`us-stock ${symbol === s ? "is-selected" : ""}`}
                      onClick={() => {
                        setSymbol(s);
                        setStrategy("");
                      }}
                    >
                      <div>
                        <strong>
                          {s}
                          {notes[s]?.saved && <Bookmark size={12} />}
                        </strong>
                        <small>
                          {count
                            ? `${count} setup${count > 1 ? "s" : ""}`
                            : f?.available
                              ? "Observe"
                              : "Missing session"}
                        </small>
                      </div>
                      <div>
                        <strong
                          className={
                            (f?.rs20 ?? 0) >= 0 ? "us-positive" : "us-negative"
                          }
                        >
                          {signed(f?.rs20)}
                        </strong>
                        <small>{signed(f?.return1)}%</small>
                      </div>
                      <ChevronRight size={14} />
                    </button>
                  );
                })}
                {!queue.length && (
                  <p className="us-empty">
                    {onlySaved
                      ? "Save a stock to begin your shortlist."
                      : "No symbols match this search."}
                  </p>
                )}
              </div>
              <p className="us-queue-footer">
                RS = excess return vs {data.benchmark}. This list does not
                represent the full US market.
              </p>
            </section>
            <section className="us-panel us-detail">
              <div className="us-detail-header">
                <div>
                  <span className="us-eyebrow">02 / INVESTIGATE</span>
                  <h2>
                    {symbol} <span>{usd(feature?.close)}</span>
                  </h2>
                  <p>
                    <span
                      className={
                        (feature?.return1 ?? 0) >= 0
                          ? "us-positive"
                          : "us-negative"
                      }
                    >
                      {signed(feature?.return1)}% last session
                    </span>{" "}
                    · {feature?.sessions || 0} observed sessions
                  </p>
                </div>
                <button
                  aria-pressed={notes[symbol]?.saved || false}
                  onClick={() => updateNote({ saved: !notes[symbol]?.saved })}
                >
                  {notes[symbol]?.saved ? (
                    <Check size={15} />
                  ) : (
                    <Bookmark size={15} />
                  )}{" "}
                  {notes[symbol]?.saved ? "Shortlisted" : "Save stock"}
                </button>
              </div>
              <div className="us-chart-toolbar">
                <div>
                  <button
                    aria-pressed={timeframe === "daily"}
                    onClick={() => setTimeframe("daily")}
                  >
                    Daily
                  </button>
                  <button
                    aria-pressed={timeframe === "weekly"}
                    onClick={() => setTimeframe("weekly")}
                  >
                    Weekly
                  </button>
                </div>
                <span>
                  {data.benchmark} benchmark · {data.session}
                </span>
              </div>
              {displayedBars.length ? (
                <Chart
                  appearance={theme}
                  key={`${packageId}-${symbol}-${timeframe}`}
                  data={displayedBars}
                  symbol={symbol}
                  height={340}
                  priceLevels={levels}
                />
              ) : (
                <p className="us-empty">No completed bars for this stock.</p>
              )}
              <div className="us-stock-metrics">
                <div>
                  <span>RS 20 sessions</span>
                  <strong>{signed(feature?.rs20)} pp</strong>
                </div>
                <div>
                  <span>RS 60 sessions</span>
                  <strong>{signed(feature?.rs60)} pp</strong>
                </div>
                <div>
                  <span>Relative volume</span>
                  <strong>{metric(feature?.rvol20)}×</strong>
                </div>
                <div>
                  <span>Avg dollar volume · 20D</span>
                  <strong>
                    {feature?.turnover20 == null
                      ? "—"
                      : `$${metric(feature.turnover20 / 1e6, 1)}M`}
                  </strong>
                </div>
              </div>
              <div className="us-thesis">
                <div className="us-panel-title">
                  <div>
                    <span className="us-eyebrow">03 / FRAME THE THESIS</span>
                    <h3>
                      {selected
                        ? selected.strategy.replaceAll("_", " ")
                        : "Observation only"}
                    </h3>
                  </div>
                  <span className="us-pill">
                    {selected
                      ? `${selected.signal} · ${selected.lifecycle_state || "Unknown phase"}`
                      : "No detected setup"}
                  </span>
                </div>
                {setups.length > 1 && (
                  <label>
                    Detected thesis
                    <select
                      aria-label="Selected setup"
                      value={selected?.setup_version || ""}
                      onChange={(e) => setStrategy(e.target.value)}
                    >
                      {setups.map((s) => (
                        <option key={s.setup_version} value={s.setup_version}>
                          {s.strategy} · {s.signal}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {selected ? (
                  <>
                    <div className="us-levels">
                      <div>
                        <span>Conditional trigger</span>
                        <strong>{usd(selected.entry_price)}</strong>
                      </div>
                      <div>
                        <span>Structural stop</span>
                        <strong>{usd(selected.stop_loss)}</strong>
                      </div>
                      <div>
                        <span>Policy objective</span>
                        <strong>{usd(selected.target)}</strong>
                      </div>
                    </div>
                    <p>{selected.notes}</p>
                    <ul>
                      {thesisReasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                    <p className="us-caution">
                      Policy objective is not measured structural room. Detected
                      does not mean actionable.
                    </p>
                  </>
                ) : (
                  <p>
                    No active detector thesis in this saved session. You can
                    still inspect price history and keep research notes.
                  </p>
                )}
              </div>
              <div className="us-notes">
                <label htmlFor="us-thesis-note">
                  Your research notes{" "}
                  <span>Saved in this browser · {symbol}</span>
                </label>
                <textarea
                  id="us-thesis-note"
                  value={note}
                  maxLength={10000}
                  onChange={(e) => updateNote({ note: e.target.value })}
                  placeholder="What is the thesis? What would invalidate it? Which event needs checking?"
                />
                <p>
                  {storageError ||
                    "Browser-local notes only. Export to keep a copy; these are not account-synced plans."}
                </p>
              </div>
            </section>
          </div>
          <section className="us-disclosures">
            <div>
              <span className="us-eyebrow">RESEARCH QUALITY</span>
              <h3>Know what the evidence covers.</h3>
              <p>
                Earnings calendar and industry leadership are not connected yet.
                Check events before considering a trade. Short histories and
                unavailable metrics remain unknown.
              </p>
            </div>
            <details>
              <summary>Methodology & source record</summary>
              <p>{data.membership_basis}</p>
              <ul>
                {data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p>Package: {data.id}</p>
              <p>
                Computed: {data.computed_at}. Weekly bars aggregate observed
                sessions; the latest week may be incomplete.
              </p>
            </details>
          </section>
        </>
      )}
      {!loading && !data && !error && (
        <div className="us-panel us-empty">
          <h2>Start your US research library</h2>
          <p>
            Refresh the universe below to publish your first completed-session
            package.
          </p>
        </div>
      )}
      <USPlans key={user?.id || "signed-out"} data={data} setup={selected} />
      <section id="us-refresh" className="us-panel us-refresh">
        <div>
          <span className="us-eyebrow">RESEARCH UNIVERSE</span>
          <h2>Choose the stocks you follow.</h2>
          <p>
            Up to 50 symbols per refresh. The starter list is curated, not an
            index or a complete market universe.
          </p>
        </div>
        <label>
          Symbols
          <textarea
            aria-label="Research universe symbols"
            value={draftSymbols}
            onChange={(e) => setDraftSymbols(e.target.value)}
          />
        </label>
        <div className="us-refresh-actions">
          <label>
            Benchmark
            <select
              aria-label="Research benchmark"
              value={benchmark}
              onChange={(e) => setBenchmark(e.target.value)}
            >
              <option>SPY</option>
              <option>QQQ</option>
            </select>
          </label>
          <button
            className="us-primary"
            onClick={() => void refresh()}
            disabled={Boolean(busy) || !draftSymbols.trim()}
          >
            <RefreshCw size={15} className={busy ? "us-spin" : ""} />
            {busy ? "Refreshing…" : "Refresh completed-session research"}
          </button>
        </div>
        {job && (
          <p role="status">
            Refresh: {job.state}
            {job.error ? ` · ${job.error}` : ""}.{" "}
            {job.state === "completed" ? "Saved research reloaded." : ""}
          </p>
        )}
      </section>
    </div>
  );
}

export default function USResearchPage() {
  return (
    <Suspense fallback={<p className="us-loading">Loading US workspace…</p>}>
      <USResearchContent />
    </Suspense>
  );
}
