import Link from "next/link";
import type { Metadata } from "next";
import "../us.css";
export const metadata: Metadata = {
  title: "US Research Guide | Alpha Radar US",
};
export default function USGuide() {
  return (
    <article className="us-terminal us-guide">
      <div className="us-eyebrow">ALPHA RADAR US / RESEARCH GUIDE</div>
      <h1>One market. Clear evidence.</h1>
      <p>
        This workspace covers US stocks in USD, with SPY or QQQ as the selected
        benchmark. All market clocks and quote timestamps use New York time
        (ET).
      </p>
      <div className="us-guide-grid">
        <section className="us-panel">
          <h2>Market context</h2>
          <p>
            Breadth describes the selected custom stock universe, not the entire
            US market. The starter list is curated. Each EMA gauge shows how
            many stocks have enough aligned history.
          </p>
          <Link href="/us#market-context">Inspect US breadth →</Link>
        </section>
        <section className="us-panel">
          <h2>Relative strength</h2>
          <p>
            RS 20 and RS 60 are stock returns minus the selected benchmark
            return over aligned completed sessions, expressed in percentage
            points. They are not percentile ranks. Missing history remains
            unknown.
          </p>
          <Link href="/us#research-queue">Research US stocks →</Link>
        </section>
        <section className="us-panel">
          <h2>Live feed diagnostics</h2>
          <p>
            IEX is a single-exchange feed. SIP is consolidated and requires the
            corresponding live-data entitlement. A successful historical request
            does not establish live access. Quote and trade timestamps are
            checked separately; stale quotes stay visible as stale.
          </p>
          <p>
            The panel polls snapshots every five seconds. It does not stream
            prices into saved daily bars or authorize trades.
          </p>
          <Link href="/us#live-data">Check the live feed →</Link>
        </section>
        <section className="us-panel">
          <h2>Setups and chart levels</h2>
          <p>
            A detector thesis shows its own conditional entry and invalidation.
            Its policy objective is not measured structural room. US detector
            thresholds remain uncalibrated. Weekly charts aggregate observed
            sessions and the latest week may be incomplete.
          </p>
          <Link href="/us#research-queue">Inspect source charts →</Link>
        </section>
        <section className="us-panel">
          <h2>Your shortlist and notes</h2>
          <p>
            Save stocks for review and keep notes in this browser. These records
            are not account-synced plans. Export research to keep a copy of the
            package and notes.
          </p>
          <Link href="/us?view=shortlist#research-queue">
            Open your shortlist →
          </Link>
        </section>
        <section className="us-panel">
          <h2>Universe and data coverage</h2>
          <p>
            Add up to 50 US symbols per research refresh, with SPY or QQQ as the
            benchmark. Histories use split adjustments. A partial package cannot
            replace the last complete publication.
          </p>
          <p>
            Earnings events, industry leadership, portfolio risk and order
            execution are not connected yet.
          </p>
          <Link href="/us#us-refresh">Manage US universe →</Link>
        </section>
      </div>
      <Link className="us-guide-back" href="/us">
        ← Back to US research
      </Link>
    </article>
  );
}
