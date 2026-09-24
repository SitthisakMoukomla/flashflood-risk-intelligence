import type { Metadata, Viewport } from "next";
import Script from "next/script";
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
  title: "Flashflood · เตือนภัยน้ำป่าทั่วประเทศ",
  description:
    "แผนที่ความเสี่ยงน้ำป่าทั่วประเทศไทย — ภูมิประเทศ × ดินอิ่มน้ำ × ฝนตอนนี้ แตะจุดใดก็ได้เพื่อดูระดับความเสี่ยง สถานีวัดน้ำใกล้เคียง และน้ำท่วมจากดาวเทียม",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Flashflood",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Map apps should fill the notch area; safe-area padding is handled in CSS.
  viewportFit: "cover",
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
        <Script id="sw-register" strategy="afterInteractive">
          {`if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(function(){}); }`}
        </Script>
      </body>
    </html>
  );
}
