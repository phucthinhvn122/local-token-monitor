import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/ui";
import { AuthProvider } from "@/components/auth-provider";

export const metadata: Metadata = {
  title: "Codex Gateway",
  description: "API key and token quota management for Codex CLI",
  robots: { index: false, follow: false }
};

export const viewport: Viewport = {
  themeColor: "#232128",
  width: "device-width",
  initialScale: 1
};

/**
 * Applies the stored theme before first paint. Without this the dark default
 * would flash light for a user who chose light, and vice versa.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem("cgw-theme");
    document.documentElement.setAttribute("data-theme", stored === "light" ? "light" : "dark");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
