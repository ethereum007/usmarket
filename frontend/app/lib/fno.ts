import { fetchAPI } from "./api";

const FNO_CACHE_KEY = "alpha-radar:fno-symbols:v1";

type FnoStockResponse = { success: boolean; stocks?: string[] };

export async function loadFnoSymbols(): Promise<Set<string>> {
  if (typeof window === "undefined") return new Set();
  const cached = window.sessionStorage.getItem(FNO_CACHE_KEY);
  if (cached) {
    try {
      return new Set((JSON.parse(cached) as string[]).map((symbol) => symbol.toUpperCase()));
    } catch {}
  }

  const response = await fetchAPI<FnoStockResponse>("/api/fno/stocks");
  const symbols = (response.stocks ?? []).map((symbol) => symbol.toUpperCase());
  window.sessionStorage.setItem(FNO_CACHE_KEY, JSON.stringify(symbols));
  return new Set(symbols);
}
