import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voom",
  description: "Voom — MARA, your AI marketing manager.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-bg text-text font-sans">
        {children}
      </body>
    </html>
  );
}
