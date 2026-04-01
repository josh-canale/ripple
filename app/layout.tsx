import type { Metadata } from "next";
import { Geist, Geist_Mono, Bitcount_Grid_Single } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
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
  metadataBase: new URL("https://ripple-sandbox.vercel.app"),
  title: "ripple",
  description: "An interactive dot field. Click to ripple, double-click to loop.",
  openGraph: {
    title: "ripple",
    description: "An interactive dot field. Click to ripple, double-click to loop.",
    url: "https://ripple-sandbox.vercel.app",
    siteName: "ripple",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "ripple — an interactive dot field" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ripple",
    description: "An interactive dot field. Click to ripple, double-click to loop.",
    images: ["/og.png"],
  },
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
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
