import { fetchAPI } from "./api";
import type { USSummary } from "./us-research";
export type USCatalog = { packages: USSummary[]; default_symbols: string; unavailable_packages?: number };

function verifyCatalog(value: USCatalog): USCatalog {
  if (!value || !Array.isArray(value.packages) || value.packages.length > 120 || typeof value.default_symbols !== "string" ||
      (value.unavailable_packages !== undefined && (!Number.isSafeInteger(value.unavailable_packages) || value.unavailable_packages < 0)) ||
      value.packages.some(row => !row || typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id) ||
        !["final", "partial"].includes(row.state) || typeof row.session !== "string" ||
        !["SPY", "QQQ"].includes(row.benchmark) || !["iex", "sip"].includes(row.feed) ||
        typeof row.computed_at !== "string" || !Number.isFinite(Date.parse(row.computed_at)) ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.computed_at) ||
        !Array.isArray(row.symbols) || row.symbols.length < 1 || row.symbols.length > 500 ||
        row.symbols.some(symbol => typeof symbol !== "string" || !/^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol)) ||
        new Set(row.symbols).size !== row.symbols.length) ||
      new Set(value.packages.map(row => row.id)).size !== value.packages.length) {
    throw new Error("Saved US research catalog could not be verified. Reload to retry.");
  }
  return value;
}

// Backend catalog order is source session, aware computation instant, then ID.
export function defaultCatalogPackage(packages: USSummary[]): USSummary | undefined {
  return packages.find(package_ => package_.state === "final") || packages[0];
}

export async function currentCatalog(isCurrent: () => boolean): Promise<USCatalog | null> {
  try {
    const result = await fetchAPI<USCatalog>("/api/us/research/packages");
    return isCurrent() ? verifyCatalog(result) : null;
  } catch (error) {
    if (isCurrent()) throw error;
    return null;
  }
}
