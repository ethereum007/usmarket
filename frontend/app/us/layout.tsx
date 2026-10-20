import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = {
  title: "Alpha Radar US | U.S. Equity Research",
  description:
    "U.S. stock research, SPY and QQQ relative strength, completed-session breadth, source charts and live quote diagnostics in USD.",
};
export default function USLayout({ children }: { children: ReactNode }) {
  return children;
}
