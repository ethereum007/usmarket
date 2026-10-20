import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: __dirname,
  // Optional local API proxy keeps preview requests on the same origin.
  // Set the backend origin explicitly in each deployment environment.
  async rewrites() {
    const upstream = process.env.ALPHA_API_PROXY_URL;
    return upstream ? [{ source: "/api/:path*", destination: `${upstream}/api/:path*` }] : [];
  },
  // Standalone US product: inherited page URLs stay inside the US workspace.
  async redirects() {
    const legacyPages = ["admin", "alpha-login", "analysis", "feedback", "fno", "guide", "heatmap", "latest-updates", "options", "pulse", "radar-trade", "rrg", "runner", "sectors", "settings", "snapshots", "stocks", "subscription", "swing", "trade-ideas"];
    return [
      { source: "/", destination: "/us", permanent: false },
      ...["login", "signup", "forgot-password", "reset-password"].map(page => ({ source: `/${page}/:path*`, destination: "/us/login", permanent: false })),
      ...legacyPages.map(page => ({ source: `/${page}/:path*`, destination: "/us", permanent: false })),
    ];
  },
  async headers() {
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' http://localhost:9000 http://127.0.0.1:9000 ws://localhost:9000 ws://127.0.0.1:9000 https://*.supabase.co wss://*.supabase.co",
      "frame-src 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
        ],
      },
    ];
  },
};

export default nextConfig;
