"use client";

import { RequireAuth } from "@/components/auth-provider";
import { AppShell } from "@/components/shell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell area="user">{children}</AppShell>
    </RequireAuth>
  );
}
