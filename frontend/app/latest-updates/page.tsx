import type { Metadata } from "next";
import { getFeed } from "./feed";
import UpdatesDashboard from "./updates-dashboard";

export const metadata: Metadata = {
  title: "Latest NSE Updates | Alpha Radar",
  description: "NSE corporate announcements, order wins, business updates and the day's announcement mix, with original exchange filings.",
};
export default async function LatestUpdates({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  return <UpdatesDashboard {...await getFeed(date)} />;
}
