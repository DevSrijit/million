import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Million · a spreadsheet engine for the browser",
  description: "A million rows, every formula live. A spreadsheet engine written from scratch: a small edit recalculates in microseconds, and nothing leaves your machine.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
