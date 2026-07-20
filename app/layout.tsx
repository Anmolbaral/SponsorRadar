import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sponsor Winback Radar",
  description:
    "Evidence-backed sponsor reactivation leads for YouTube creators",
  robots: {
    index: false,
    follow: false,
    nocache: true
  }
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
