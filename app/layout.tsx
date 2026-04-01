import type { Metadata } from "next";
import { Geist, Geist_Mono, Bitcount_Grid_Single } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bitcount = Bitcount_Grid_Single({
  weight: ["400"],
  variable: "--font-bitcount",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ripple",
  description: "An interactive ripple field — click to create waves, double-click to loop.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bitcount.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
