import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recursive, software that fixes itself",
  description:
    "Detects breakage in production, including the silent kind nothing else catches, contains it, and opens a verified fix.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background">{children}</body>
    </html>
  );
}
