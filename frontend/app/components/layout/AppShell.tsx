"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { USWorkspaceNav } from "./USWorkspaceNav";
import { WorkspaceNav } from "./WorkspaceNav";
import { TickerStrip } from "./TickerStrip";
import { ProtectedRoute } from "../auth/ProtectedRoute";
import { USAccessGuard } from "../auth/USAccessGuard";
import { PremiumFeedHeartbeat } from "../data/PremiumFeedHeartbeat";

const AUTH_PAGES = ["/us/login","/login", "/signup", "/forgot-password", "/reset-password"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isUSResearch = pathname === "/us" || pathname.startsWith("/us/");
  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));

  // Auth pages (login, signup) render without nav/ticker
  if (isAuthPage) {
    return <>{children}</>;
  }

  const AccessGuard = isUSResearch ? USAccessGuard : ProtectedRoute;

  // All other pages get top nav + ticker + auth protection
  return (
    <AccessGuard>
      <div className="app-viewport workspace-shell">
        <a href="#workspace-content" className="skip-link">Skip to content</a>
        {!isUSResearch && <PremiumFeedHeartbeat />}
        <Suspense fallback={null}>
          {isUSResearch ? <USWorkspaceNav /> : <WorkspaceNav />}
        </Suspense>
        <div className="workspace-body">
          {!isUSResearch && <TickerStrip />}
          <main id="workspace-content" tabIndex={-1} className="app-main-scroll workspace-content">{children}</main>
        </div>
      </div>
    </AccessGuard>
  );
}
