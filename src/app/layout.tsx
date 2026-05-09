import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Thai, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const plexThai = IBM_Plex_Sans_Thai({
  variable: "--font-plex-thai",
  subsets: ["thai", "latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Flashflood · เตือนภัยน้ำป่า ภาคเหนือ",
  description:
    "เตือนภัยน้ำป่าระดับตำบลใน 9 จังหวัดภาคเหนือ — ผสาน hazard surface จาก Google Earth Engine กับฝนสะสม + radar API สำหรับเตือนภัยตามจริง",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#071318",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th" className={`${plexThai.variable} ${plexMono.variable}`}>
      <body style={{ fontFamily: "var(--font-plex-thai), var(--font-ui)" }}>
        {children}
      </body>
    </html>
  );
}
