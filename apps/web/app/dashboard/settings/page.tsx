"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/components/auth-provider";
import { PageHeader } from "@/components/shell";
import { Badge, Button, Card, CardHeader, CopyButton, Field, Input, Skeleton, useToast } from "@/components/ui";

function TwoFactorCard() {
  const { data, loading, reload } = useApi<{ user: { totpEnabled?: boolean; role: string } }>("/api/auth/me");
  const toast = useToast();
  const [enrolment, setEnrolment] = React.useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [disabling, setDisabling] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const enabled = data?.user?.totpEnabled === true;

  const run = async (action: () => Promise<{ message?: string }>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      toast(result.message ?? fallback, "success");
      setEnrolment(null);
      setDisabling(false);
      setCode("");
      setPassword("");
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        description="A 6-digit code from an authenticator app, required at every sign-in."
        action={
          loading ? undefined : enabled ? (
            <Badge tone="safe">
              <ShieldCheck className="h-3 w-3" />
              Enabled
            </Badge>
          ) : (
            <Badge tone="neutral">Off</Badge>
          )
        }
      />
      <div className="space-y-4 px-5 pb-5 pt-4">
        {loading ? (
          <Skeleton className="h-16" />
        ) : enabled ? (
          disabling ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () => api.post("/api/auth/totp/disable", { password, code }),
                  "Two-factor authentication is off."
                );
              }}
            >
              <Field label="Password">
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Field label="Current code" error={error ?? undefined}>
                <Input
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="danger" loading={busy}>
                  Turn off 2FA
                </Button>
                <Button type="button" onClick={() => setDisabling(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <p className="text-[13px] text-[var(--text-muted)]">
                Your account asks for an authenticator code at every sign-in. Turning it off requires both
                your password and a current code.
              </p>
              <Button variant="danger" onClick={() => setDisabling(true)}>
                Turn off…
              </Button>
            </>
          )
        ) : enrolment ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () => api.post("/api/auth/totp/enable", { code }),
                "Two-factor authentication is on."
              );
            }}
          >
            <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)]/40 p-3">
              <p className="text-[12px] text-[var(--text-muted)]">
                1 · Add this secret to your authenticator app (Google Authenticator, 1Password, Aegis…)
                — paste the setup link, or enter the secret manually.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="tabular break-all rounded bg-[var(--bg)] px-2 py-1 font-mono text-[12px]">
                  {enrolment.secret}
                </code>
                <CopyButton value={enrolment.secret} label="Copy secret" />
                <CopyButton value={enrolment.otpauthUri} label="Copy setup link" />
              </div>
            </div>
            <Field
              label="2 · Enter the code the app shows"
              hint="This proves the enrolment worked before it becomes required."
              error={error ?? undefined}
            >
              <Input
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                placeholder="123456"
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy}>
                Confirm and enable
              </Button>
              <Button type="button" onClick={() => setEnrolment(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="text-[13px] text-[var(--text-muted)]">
              {data?.user?.role === "ADMIN"
                ? "Strongly recommended for administrator accounts — this account can mint API keys and read every log."
                : "Adds a second check at sign-in, so a leaked password alone is not enough."}
            </p>
            {error && <p className="text-[12px] text-[var(--color-critical)]">{error}</p>}
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setEnrolment(await api.post("/api/auth/totp/setup"));
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : "Could not start enrolment");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ShieldCheck className="h-4 w-4" />
              Enable two-factor
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

export default function AccountSettingsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("The two new passwords do not match");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ message: string }>("/api/auth/password", {
        currentPassword,
        newPassword
      });
      toast(result.message, "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the password");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader title="Account" description="Your profile and sign-in credentials." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <dl className="space-y-3 px-5 pb-5 pt-4 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-[var(--text-muted)]">Name</dt>
              <dd>{user?.name ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--text-muted)]">Email</dt>
              <dd>{user?.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--text-muted)]">Role</dt>
              <dd>{user?.role === "ADMIN" ? "Administrator" : "Member"}</dd>
            </div>
          </dl>
          <p className="px-5 pb-5 text-[12px] text-[var(--text-faint)]">
            Profile details are managed by an administrator.
          </p>
        </Card>

        <Card>
          <CardHeader
            title="Change password"
            description="Changing it signs you out everywhere else."
          />
          <form onSubmit={submit} className="space-y-4 px-5 pb-5 pt-4">
            <Field label="Current password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field label="New password" hint="At least 10 characters.">
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
            <Field label="Confirm new password" error={error ?? undefined}>
              <Input
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" loading={submitting}>
              Update password
            </Button>
          </form>
        </Card>

        <TwoFactorCard />
      </div>
    </>
  );
}
