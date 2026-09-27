import type { Metadata } from "next";
import { BmrDashboard } from "@/components/BmrDashboard";

export const metadata: Metadata = {
  title: "ศูนย์ข้อมูลน้ำ กรุงเทพฯ และปริมณฑล · Flashflood",
  description:
    "คลองและประตูน้ำ กทม. ตามเกณฑ์ของสำนักการระบายน้ำ สถานีแม่น้ำ สสน./ชป. พร้อมกราฟ 30 วัน ฝนรายชั่วโมง กล้องจราจร น้ำท่วมจากดาวเทียม เรดาร์ และน้ำทะเลหนุน — 6 จังหวัดกรุงเทพฯ และปริมณฑล",
};

export default function BmrPage() {
  return (
    <main>
      <BmrDashboard />
    </main>
  );
}
