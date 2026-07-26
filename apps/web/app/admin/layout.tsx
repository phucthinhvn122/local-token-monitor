"use client";

import { RequireAuth } from "@/components/auth-provider";
import { AppShell } from "@/components/shell";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth role="ADMIN">
      <AppShell area="admin">{children}</AppShell>
    </RequireAuth>
  );
}
