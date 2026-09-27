import type { Metadata } from "next";
import { KrathumLomDashboard } from "@/components/KrathumLomDashboard";

export const metadata: Metadata = {
  title: "เทศบาลเมืองกระทุ่มล้ม · Flashflood",
  description:
    "ข้อมูลน้ำท่วมสำหรับเจ้าหน้าที่เทศบาลเมืองกระทุ่มล้ม — ฝนและระดับน้ำจากสถานีรอบเทศบาล พร้อมประวัติน้ำท่วมจากดาวเทียม Sentinel-1 ตั้งแต่ปี 2015 และบ้านเรือนที่เกี่ยวข้อง",
};

export default function KrathumLomPage() {
  return (
    <main>
      <KrathumLomDashboard />
    </main>
  );
}
