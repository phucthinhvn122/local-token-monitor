"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";

/** Route to the right area once the session is known. */
export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else router.replace(user.role === "ADMIN" ? "/admin" : "/dashboard");
  }, [user, loading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="skeleton h-8 w-8 rounded-full" />
    </div>
  );
}
