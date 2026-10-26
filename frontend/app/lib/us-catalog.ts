import { fetchAPI } from "./api";
import type { USSummary } from "./us-research";
export type USCatalog = { packages: USSummary[]; default_symbols: string; unavailable_packages?: number };

// Backend catalog order is source session, aware computation instant, then ID.
export function defaultCatalogPackage(packages: USSummary[]): USSummary | undefined {
  return packages.find(package_ => package_.state === "final") || packages[0];
}

export async function currentCatalog(isCurrent: () => boolean): Promise<USCatalog | null> {
  try {
    const result = await fetchAPI<USCatalog>("/api/us/research/packages");
    return isCurrent() ? result : null;
  } catch (error) {
    if (isCurrent()) throw error;
    return null;
  }
}
