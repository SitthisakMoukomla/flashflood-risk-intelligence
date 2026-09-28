import type { Metadata } from "next";
import { Bai_Jamjuree, Chakra_Petch } from "next/font/google";
import { BmrApp } from "@/components/BmrApp";

// The sheet and board have their own type: a squarish Thai display face for
// labels and numbers, a plain one for text. Loaded here so the dashboard's
// global Plex stays untouched.
const chakra = Chakra_Petch({ subsets: ["thai", "latin"], weight: ["500", "600", "700"], variable: "--font-chakra", display: "swap" });
const bai = Bai_Jamjuree({ subsets: ["thai", "latin"], weight: ["400", "500", "600"], variable: "--font-bai", display: "swap" });

export const metadata: Metadata = {
  title: "รอระบาย · กรุงเทพฯ และปริมณฑล · Flashflood",
  description:
    "ผังคลอง กทม. ตามเกณฑ์ของสำนักการระบายน้ำ สถานีแม่น้ำ สสน./ชป. พร้อมแผนที่จริง กราฟ 30 วัน ฝนรายชั่วโมง กล้อง น้ำท่วมจากดาวเทียม เรดาร์ และน้ำทะเลหนุน — 6 จังหวัดกรุงเทพฯ และปริมณฑล",
};

export default function BmrPage() {
  return (
    <main className={`${chakra.variable} ${bai.variable}`}>
      <BmrApp />
    </main>
  );
}
