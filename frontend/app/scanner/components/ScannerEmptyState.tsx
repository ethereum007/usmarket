import { ScanLine } from "lucide-react";

export function ScannerEmptyState({ scanned }: { scanned: boolean }) {
  return <section className="scanner-empty" role="status">
    <span className="scanner-empty-icon"><ScanLine size={25} strokeWidth={1.5} /></span>
    <h2>{scanned ? "No setups found in this scan" : "Your next setup starts here"}</h2>
    <p>{scanned ? "Try another universe or scan again after the next market session. Keep your criteria selective." : "Choose a universe and use the scan button above. Results will include the available levels, scores and supporting evidence."}</p>
    {!scanned && <div className="scanner-empty-steps"><span>01 · Choose your universe</span><span>02 · Run the scan</span><span>03 · Inspect the evidence</span></div>}
  </section>;
}
