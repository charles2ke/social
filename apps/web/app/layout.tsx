import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "./components/app-shell";
import { themeScript } from "./components/theme-script";

export const metadata: Metadata = {
  title: "Social — self-hosted social media manager",
  description: "Compose once, publish everywhere, from your own infrastructure.",
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
