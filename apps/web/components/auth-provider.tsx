"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "SUSPENDED";
}

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => undefined,
  logout: async () => undefined
});

export function useAuth(): AuthState {
  return React.useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const router = useRouter();

  const refresh = React.useCallback(async () => {
    try {
      const data = await api.get<{ user: SessionUser }>("/api/auth/me");
      setUser(data.user);
    } catch (error) {
      // 401 is the normal signed-out state, not an error worth surfacing.
      if (!(error instanceof ApiError) || error.status !== 401) console.error(error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = React.useCallback(async () => {
    await api.post("/api/auth/logout").catch(() => undefined);
    setUser(null);
    router.push("/login");
  }, [router]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = React.useMemo(() => ({ user, loading, refresh, logout }), [user, loading, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Client-side guard. The gateway enforces authorisation on every endpoint, so
 * this is purely a navigation convenience — no data is gated by it.
 */
export function RequireAuth({ role, children }: { role?: "ADMIN"; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else if (role === "ADMIN" && user.role !== "ADMIN") router.replace("/dashboard");
  }, [user, loading, role, router]);

  if (loading || !user || (role === "ADMIN" && user.role !== "ADMIN")) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="skeleton h-8 w-8 rounded-full" />
      </div>
    );
  }
  return <>{children}</>;
}
