"use client";
import { metric, signed, type USPackage } from "../lib/us-research";

export function sessionBrief(data: USPackage) {
  const symbols = [...new Set(data.symbols)];
  const available = symbols.filter(symbol => data.features[symbol]?.available).length;
  const ranked = symbols.filter(symbol => {
    const feature = data.features[symbol];
    const record = data.instrument_snapshot?.records[symbol];
    return feature?.available && typeof feature.rs20 === "number" && Number.isFinite(feature.rs20)
      && !data.history_gaps?.[symbol]?.length && !data.instrument_exclusions?.[symbol]
      && record?.resolution === "resolved";
  }).sort((a, b) => data.features[b].rs20! - data.features[a].rs20! || a.localeCompare(b));
  return { requested: symbols.length, available, rankable: ranked.length,
    leaders: ranked.slice(0, 5).map(symbol => ({ symbol, feature: data.features[symbol],
      setups: data.setups.filter(setup => setup.symbol === symbol).length })) };
}

export default function SessionBrief({ data, onInspect }: { data: USPackage; onInspect: (symbol: string) => void }) {
  const brief = sessionBrief(data);
  return <section className="us-panel my-6 p-5 space-y-3" aria-labelledby="session-brief-title">
    <span className="us-eyebrow">START YOUR RESEARCH</span>
    <h2 id="session-brief-title">Session brief · {data.session}</h2>
    <p>Saved {data.state} research · {data.benchmark} benchmark · {data.feed.toUpperCase()} feed. This describes the selected session, not current market conditions.</p>
    <p>{brief.available} of {brief.requested} requested stocks have available features; {brief.rankable} have rankable 20-session relative strength after history and instrument checks. This custom list does not represent the entire US market.</p>
    {data.state !== "final" && <p role="status">Partial research: inspect coverage and source warnings. A saved plan requires a final package.</p>}
    <p>Highest 20-session relative strength in this saved list. Negative values still trail {data.benchmark}; these are research candidates, not trade recommendations.</p>
    {brief.leaders.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <caption className="sr-only">Relative strength candidates for saved session {data.session}</caption>
      <thead><tr><th scope="col">Stock</th><th scope="col">20-session RS</th><th scope="col">60-session RS</th><th scope="col">Detected setups</th><th scope="col">Evidence</th></tr></thead>
      <tbody>{brief.leaders.map(row => <tr key={row.symbol}>
        <th scope="row">{row.symbol}</th><td>{signed(row.feature.rs20)} pp</td><td>{row.feature.rs60 == null || !Number.isFinite(row.feature.rs60) ? "Unknown" : `${signed(row.feature.rs60)} pp`}</td>
        <td>{metric(row.setups, 0)}</td><td><button type="button" className="workspace-button" onClick={() => onInspect(row.symbol)}>Inspect {row.symbol}</button></td>
      </tr>)}</tbody>
    </table></div> : <p>No eligible relative-strength candidates in this package. Missing evidence is not evidence of no opportunities.</p>}
    <p>Earnings date and BMO/AMC timing remain unknown. Industry leadership and strategy edge are unverified.</p>
    <p>Next: inspect a candidate’s chart and SEC evidence, review trigger and invalidation, then save a conditional plan if the package is final. A detected setup does not establish a fill.</p>
  </section>;
}
