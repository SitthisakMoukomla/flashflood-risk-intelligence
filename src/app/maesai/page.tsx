import type { Metadata } from "next";
import { MaeSaiWatch } from "@/components/MaeSaiWatch";

export const metadata: Metadata = {
  title: "เฝ้าระวังแม่สาย · Flashflood",
  description:
    "ระดับน้ำแม่น้ำสายจากสถานีตรวจวัดจริงของ สสน. เรียงจากต้นน้ำถึงสะพานมิตรภาพแม่สาย พร้อมแนวโน้มขึ้น-ลงและประวัติที่บันทึกไว้",
};

export default function MaeSaiPage() {
  return (
    <main>
      <MaeSaiWatch />
    </main>
  );
}
