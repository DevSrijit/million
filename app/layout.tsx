import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://millionrows.vercel.app"),
  title: "Million · a spreadsheet engine for the browser",
  description: "A million rows, every formula live. A spreadsheet engine written from scratch: a small edit recalculates in microseconds, and nothing leaves your machine.",
  openGraph: { siteName: "Million", type: "website" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
