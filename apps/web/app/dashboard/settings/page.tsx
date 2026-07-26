"use client";

import * as React from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import { PageHeader } from "@/components/shell";
import { Button, Card, CardHeader, Field, Input, useToast } from "@/components/ui";

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
      </div>
    </>
  );
}
