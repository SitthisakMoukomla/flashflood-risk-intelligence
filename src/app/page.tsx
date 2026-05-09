import { FloodMap } from "@/components/FloodMap";
import { productCopy, riskZones, sourceNotes } from "@/lib/risk-intelligence";

export default function Home() {
  return (
    <main>
      <FloodMap
        copy={productCopy}
        sources={sourceNotes}
        zones={riskZones}
      />
    </main>
  );
}
