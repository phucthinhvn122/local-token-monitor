"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ClipboardList,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Server,
  Settings,
  Sun,
  Terminal,
  Users,
  X,
  Zap
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/keys", label: "API keys", icon: KeyRound },
  { href: "/admin/providers", label: "Pool providers", icon: Server },
  { href: "/admin/logs", label: "Request logs", icon: Activity },
  { href: "/admin/audit", label: "Audit trail", icon: ClipboardList },
  { href: "/admin/settings", label: "Settings", icon: Settings }
];

const USER_NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/connect", label: "Connect Codex CLI", icon: Terminal },
  { href: "/dashboard/logs", label: "My requests", icon: Activity },
  { href: "/dashboard/settings", label: "Account", icon: Settings }
];

function ThemeToggle() {
  const [theme, setTheme] = React.useState<"dark" | "light">("dark");

  React.useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "light" ? "light" : "dark");
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("cgw-theme", next);
    } catch {
      // Private browsing can block storage; the toggle still works for this tab.
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      className="rounded-lg p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text)]"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function AppShell({ area, children }: { area: "admin" | "user"; children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const nav = area === "admin" ? ADMIN_NAV : USER_NAV;
  const root = area === "admin" ? "/admin" : "/dashboard";

  // Close the drawer whenever navigation happens.
  React.useEffect(() => setMobileOpen(false), [pathname]);

  const isActive = (href: string) => (href === root ? pathname === href : pathname.startsWith(href));

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-[var(--border)]",
          "bg-[var(--bg-elevated)] transition-transform lg:static lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <Link href={root} className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent-500)]">
              <Zap className="h-4 w-4 text-white" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">Codex Gateway</span>
          </Link>
          <button
            className="text-[var(--text-faint)] lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-2">
          <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]">
            {area === "admin" ? "Administration" : "Workspace"}
          </p>
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                isActive(item.href)
                  ? "bg-[var(--bg-subtle)] text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text)]"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}

          {user?.role === "ADMIN" && (
            <Link
              href={area === "admin" ? "/dashboard" : "/admin"}
              className="mt-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-[var(--color-accent-400)] hover:bg-[var(--bg-subtle)]"
            >
              <LayoutDashboard className="h-4 w-4" />
              {area === "admin" ? "My dashboard" : "Admin area"}
            </Link>
          )}
        </nav>

        <div className="border-t border-[var(--border)] p-3">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{user?.name ?? user?.email}</p>
              <p className="truncate text-[11px] text-[var(--text-faint)]">
                {user?.role === "ADMIN" ? "Administrator" : "Member"}
              </p>
            </div>
            <ThemeToggle />
            <button
              onClick={() => void logout()}
              aria-label="Sign out"
              className="rounded-lg p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text)]"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 lg:hidden">
          <button onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold">Codex Gateway</span>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-[var(--text-muted)]">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export { Button };
