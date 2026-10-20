import { Activity, ArrowLeftRight, BarChart3, Bell, BookOpen, CircleHelp, FlaskConical, Gauge, Globe2, Grid2X2, History, LayoutDashboard, LineChart, Newspaper, Radar, ScanLine, Settings2, ShieldCheck, Target, TrendingUp, type LucideIcon } from "lucide-react";

export type WorkspaceLink = { href: string; label: string; icon: LucideIcon; tabs?: string[]; admin?: boolean; premium?: boolean };
export const WORKSPACE_GROUPS: { label: string; links: WorkspaceLink[] }[] = [
  { label: "Market", links: [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    { href: "/pulse", label: "Alpha Radar", icon: Radar },
    { href: "/sectors", label: "Sector rotation", icon: BarChart3 },
    { href: "/heatmap", label: "Market heatmap", icon: Grid2X2 },
    { href: "/analysis", label: "Market breadth", icon: Activity },
  ] },
  { label: "Discover", links: [
    { href: "/us", label: "US research", icon: Globe2, premium: true },
    { href: "/swing", label: "Swing research & plans", icon: TrendingUp, premium: true },
    { href: "/options", label: "Options flow", icon: ArrowLeftRight },
    { href: "/fno", label: "F&O radar", icon: Gauge, premium: true },
    { href: "/trade-ideas?tab=swing", label: "Swing & scanners", icon: ScanLine, premium: true, tabs: ["signals", "cpr", "patterns", "vcp", "nr", "volume", "bounce52w", "instbuy", "swing", "abnormal"] },
    { href: "/stocks", label: "Stock screener", icon: TrendingUp },
    { href: "/rrg", label: "Relative rotation", icon: Target },
  ] },
  { label: "Review", links: [
    { href: "/trade-ideas?tab=performance", label: "Performance", icon: LineChart, premium: true, tabs: ["performance", "algos"] },
    { href: "/trade-ideas?tab=alerts", label: "Alerts", icon: Bell, premium: true, tabs: ["alerts"] },
    { href: "/snapshots", label: "Snapshot replay", icon: History },
    { href: "/latest-updates", label: "Latest updates", icon: Newspaper },
  ] },
  { label: "Administration", links: [
    { href: "/runner", label: "Runner lab", icon: FlaskConical, admin: true },
    { href: "/admin/signals", label: "Signal validation", icon: ShieldCheck, admin: true },
    { href: "/alpha-login", label: "Data connections", icon: Settings2, admin: true },
  ] },
];
export const SUPPORT_LINKS: WorkspaceLink[] = [
  { href: "/guide", label: "Trading guide", icon: BookOpen },
  { href: "/feedback", label: "Help & feedback", icon: CircleHelp },
];
export function linkIsActive(link: WorkspaceLink, pathname: string, tab: string | null) {
  if (link.tabs) return pathname === "/trade-ideas" && link.tabs.includes(tab || "signals");
  return link.href === "/" ? pathname === "/" : pathname === link.href || pathname.startsWith(`${link.href}/`);
}
