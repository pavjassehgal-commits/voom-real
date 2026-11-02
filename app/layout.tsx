import type { Metadata } from "next";
import { Bricolage_Grotesque, DM_Sans, Public_Sans, IBM_Plex_Mono } from "next/font/google";
import { THEME_INIT_SCRIPT } from "@/lib/voom/theme";
import { VOOM_APP_ICON } from "@/lib/voom/brand-assets";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
});

// Redesign typeface (Figma export): applied inside the signed-in shell only.
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://voom.today"),
  title: "Voom",
  description: "Voom — MARA, your AI marketing manager.",
  openGraph: {
    title: "Voom",
    description: "Voom — MARA, your AI marketing manager.",
    images: [{ url: VOOM_APP_ICON, width: 1024, height: 1024, alt: "Voom official app icon" }],
  },
  twitter: { card: "summary", images: [{ url: VOOM_APP_ICON, alt: "Voom official app icon" }] },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${publicSans.variable} ${dmSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-text font-sans">
        {/*
          Applies the persisted theme before the first paint. It only sets
          `data-theme` on <html>: the React markup is identical on the server and
          on the first client render (see lib/voom/theme.ts), so this can never
          cause a hydration mismatch — it just stops a returning dark-theme user
          from seeing a light flash.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
