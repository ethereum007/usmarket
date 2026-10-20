import OptionsChainContent from "../components/pages/OptionsChainContent";
import { PageHeader } from "../components/layout/PageHeader";

export default function OptionsPage() {
  return <div className="mx-auto w-full max-w-[1500px] min-w-0 space-y-5">
    <PageHeader eyebrow="Positioning & derivatives" title="Options flow" description="Open interest, price and positioning. One complete view of the chain." />
    <OptionsChainContent />
  </div>;
}
