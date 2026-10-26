"use client";
import { useEffect, useRef, useState } from "react";
import { fetchAPI } from "../lib/api";

type History = { schema_version: number; market: string; currency: string; revision_count: number; plan_revisions: unknown[] };
export default function PlanExport() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lifecycle = useRef({ active: true, busy: false });
  useEffect(() => {
    lifecycle.current.active = true;
    return () => { lifecycle.current.active = false; };
  }, []);
  async function download() {
    const current = lifecycle.current;
    if (current.busy || !current.active) return;
    current.busy = true; setPending(true); setError("");
    try {
      const history = await fetchAPI<History>("/api/us/plans/export");
      if (!current.active) return;
      if (history.schema_version !== 1 || history.market !== "US" || history.currency !== "USD" ||
          !Array.isArray(history.plan_revisions) || history.plan_revisions.length > 10000 ||
          history.revision_count !== history.plan_revisions.length) throw new Error("Invalid history");
      const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      try {
        link.href = url; link.download = "usmarket-plan-history.json";
        document.body.appendChild(link); link.click();
      } finally { link.remove(); URL.revokeObjectURL(url); }
    } catch {
      if (current.active) setError("Plan history download was not confirmed. Try again; no saved plans were changed.");
    } finally {
      current.busy = false;
      if (current.active) setPending(false);
    }
  }
  return <div>
    <button type="button" className="workspace-button" disabled={pending} onClick={() => void download()}>{pending ? "Preparing private download…" : "Download private plan history"}</button>
    <p className="text-xs text-text-secondary">All saved plan revisions for this account. Keep the file private. Research packages and browser notes are excluded; this is not a complete backup or confirmed restore.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
