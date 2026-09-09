import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Construction Q&A",
  description: "Ask grounded questions about construction permits, projects, and contracts.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
