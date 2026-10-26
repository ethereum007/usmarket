import { supabase } from "./supabase";

const GATEWAY_URL = process.env.NEXT_PUBLIC_API_URL || "";
const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`
    : "ws://localhost:9000");
const API_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || 12000);
const AUTH_SESSION_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_AUTH_SESSION_TIMEOUT_MS || 6000);

export async function fetchAPI<T = any>(path: string): Promise<T> {
  const res = await fetchWithAuthRetry(path, {
    credentials: "include",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  return res.json();
}

export async function postAPI<T = any>(path: string, body: any): Promise<T> {
  const res = await fetchWithAuthRetry(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  return res.json();
}

export async function deleteAPI<T = any>(path: string): Promise<T> {
  const res = await fetchWithAuthRetry(path, {
    method: "DELETE",
    credentials: "include",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  return res.json();
}

export function getWSUrl(): string {
  return `${WS_URL}/ws`;
}

export function getLoginUrl(): string {
  return `${GATEWAY_URL}/api/auth/login-url`;
}

let cachedAccessToken: string | null = null;
let sessionLoaded = false;
let sessionLoadPromise: Promise<void> | null = null;
let sessionRefreshPromise: Promise<string | null> | null = null;
let authListenerReady = false;
let authVersion = 0;

export function primeAuthAccessToken(accessToken: string | null): void {
  authVersion++;
  cachedAccessToken = accessToken;
  sessionLoaded = Boolean(accessToken);
}

async function authHeaders(): Promise<Record<string, string>> {
  if (typeof window === "undefined" || !supabase) return {};

  ensureAuthListener();
  const startedVersion = authVersion;

  if (!sessionLoaded) {
    sessionLoadPromise ??= withTimeout(
      supabase.auth.getSession(),
      AUTH_SESSION_TIMEOUT_MS,
      "Auth session lookup timed out",
    )
      .then(({ data: { session } }) => {
        if (authVersion !== startedVersion) return;
        cachedAccessToken = session?.access_token ?? null;
        sessionLoaded = true;
      })
      .catch(() => {
        if (authVersion !== startedVersion) return;
        cachedAccessToken = null;
        // A transient Web Lock or storage delay must not permanently cache an
        // unauthenticated state for every API request in this browser tab.
        sessionLoaded = false;
      })
      .finally(() => {
        sessionLoadPromise = null;
      });
    await sessionLoadPromise;
  }
  if (authVersion !== startedVersion) {
    throw new Error("Account changed while preparing the request. Review the current account before retrying.");
  }

  return cachedAccessToken ? { Authorization: `Bearer ${cachedAccessToken}` } : {};
}

async function fetchWithAuthRetry(path: string, init: RequestInit): Promise<Response> {
  // Recheck after the caller awaited headers: an auth event can run in that gap.
  if (path.startsWith("/api/us/")) {
    const preparedToken = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /i, "") || null;
    if (preparedToken !== cachedAccessToken && (!tokenSubject(preparedToken) || tokenSubject(preparedToken) !== tokenSubject(cachedAccessToken))) {
      throw new Error("Account changed while preparing the request. Review the current account before retrying.");
    }
  }
  const response = await fetchWithTimeout(path, init);
  if (!(await isExpiredAppSession(path, response))) return response;

  const usRequest = path.startsWith("/api/us/");
  const originalSubject = usRequest ? tokenSubject(new Headers(init.headers).get("Authorization")?.replace(/^Bearer /i, "") || null) : null;
  if (usRequest && (!originalSubject || originalSubject !== tokenSubject(cachedAccessToken))) return response;

  const accessToken = await refreshAccessToken();
  if (!accessToken || (usRequest && originalSubject !== tokenSubject(accessToken))) return response;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetchWithTimeout(path, { ...init, headers });
}

// Unverified JWT subject is used only to prevent cross-account replay, never to grant access.
function tokenSubject(token: string | null): string | null {
  try {
    if (!token || token.length > 8192 || token.split(".").length !== 3) return null;
    const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const subject = JSON.parse(atob(encoded)).sub;
    return typeof subject === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(subject) ? subject.toLowerCase() : null;
  } catch { return null; }
}

async function isExpiredAppSession(path: string, response: Response): Promise<boolean> {
  if (response.status !== 401 || !supabase) return false;
  try {
    const payload = await response.clone().json();
    const detail = String(payload?.detail || payload?.message || "").toLowerCase();
    if (path.startsWith("/api/us/")) {
      return response.headers.get("www-authenticate")?.toLowerCase() === "bearer" &&
        detail === "sign in to the us workspace";
    }
    return (
      detail.includes("invalid or expired token") ||
      detail.includes("missing or malformed authorization")
    );
  } catch {
    return false;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const startedVersion = authVersion;
  sessionRefreshPromise ??= withTimeout(
    supabase.auth.refreshSession(),
    AUTH_SESSION_TIMEOUT_MS,
    "Auth session refresh timed out",
  )
    .then(({ data, error }) => {
      if (error) throw error;
      const nextToken = data.session?.access_token ?? null;
      // Auth events may switch accounts/sign out while refresh is in flight.
      // The refresh event itself is safe only when it installed this exact token.
      if (authVersion !== startedVersion && cachedAccessToken !== nextToken) return null;
      cachedAccessToken = nextToken;
      sessionLoaded = Boolean(cachedAccessToken);
      return cachedAccessToken;
    })
    .catch(() => {
      if (authVersion === startedVersion) {
        cachedAccessToken = null;
        sessionLoaded = false;
      }
      return null;
    })
    .finally(() => {
      sessionRefreshPromise = null;
    });
  return sessionRefreshPromise;
}

async function fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    return await fetch(`${GATEWAY_URL}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`API request timed out after ${Math.round(API_TIMEOUT_MS / 1000)}s: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function ensureAuthListener() {
  if (authListenerReady || typeof window === "undefined" || !supabase) return;
  authListenerReady = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    primeAuthAccessToken(session?.access_token ?? null);
  });
}

async function apiErrorMessage(res: Response): Promise<string> {
  if (res.status === 429) {
    return "Market data is temporarily busy. Your latest saved view is still available; please retry shortly.";
  }
  try {
    const payload = await res.clone().json();
    const detail = payload?.detail || payload?.message || payload?.error;
    if (typeof detail === "string" && detail.trim()) {
      return `API error ${res.status}: ${detail}`;
    }
    if (Array.isArray(detail) && detail.length) {
      return `API error ${res.status}: ${detail.map((item) => item?.msg || item?.message || JSON.stringify(item)).join(", ")}`;
    }
  } catch {
    try {
      const text = await res.clone().text();
      if (text.trim()) return `API error ${res.status}: ${text.slice(0, 180)}`;
    } catch {}
  }
  return `API error: ${res.status}`;
}
