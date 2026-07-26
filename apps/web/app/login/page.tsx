"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Zap } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth, type SessionUser } from "@/components/auth-provider";
import { Button, Card, Field, Input } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const { refresh, user, loading } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [totpCode, setTotpCode] = React.useState("");
  const [totpRequired, setTotpRequired] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Already signed in: skip the form.
  React.useEffect(() => {
    if (!loading && user) router.replace(user.role === "ADMIN" ? "/admin" : "/dashboard");
  }, [user, loading, router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const data = await api.post<{ user: SessionUser }>("/api/auth/login", {
        email,
        password,
        ...(totpRequired && totpCode ? { totpCode } : {})
      });
      await refresh();
      router.replace(data.user.role === "ADMIN" ? "/admin" : "/dashboard");
    } catch (caught) {
      // The account has 2FA: swap in the code field instead of failing.
      if (caught instanceof ApiError && caught.code === "totp_required") {
        setTotpRequired(true);
        setError(null);
      } else if (caught instanceof ApiError && caught.code === "totp_invalid") {
        setTotpRequired(true);
        setTotpCode("");
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "Sign-in failed");
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-accent-500)]">
            <Zap className="h-5 w-5 text-white" />
          </span>
          <h1 className="text-lg font-semibold tracking-tight">Sign in to Codex Gateway</h1>
          <p className="mt-1 text-[13px] text-[var(--text-muted)]">
            Use the account your administrator created for you.
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••"
              />
            </Field>

            {totpRequired && (
              <Field label="Two-factor code" hint="The 6-digit code from your authenticator app.">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--color-accent-400)]" />
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    required
                    autoFocus
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ""))}
                    placeholder="123456"
                    className="tabular tracking-[0.3em]"
                  />
                </div>
              </Field>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-[var(--color-critical)]/40 bg-[var(--color-critical)]/10 px-3 py-2 text-[13px] text-[var(--color-critical)]"
              >
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" loading={submitting} className="w-full">
              Sign in
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-[12px] text-[var(--text-faint)]">
          Self-hosted gateway · your requests never leave your infrastructure
        </p>
      </div>
    </div>
  );
}
