"use client";

import * as React from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { PageHeader } from "@/components/shell";
import { Button, Card, CardHeader, ErrorState, Field, Input, Select, Skeleton, useToast } from "@/components/ui";

interface Settings {
  routingStrategy: "PRIORITY" | "ROUND_ROBIN" | "WEIGHTED";
  circuitThreshold: number;
  circuitCooldownSeconds: number;
  logRetentionDays: number;
  defaultRateLimitPerMin: number;
  defaultMaxConcurrent: number;
  quotaWarnPercent: number;
  gatewayPublicUrl: string | null;
  defaultModel: string;
}

export default function AdminSettingsPage() {
  const { data, error, loading, reload } = useApi<{ settings: Settings }>("/api/admin/settings");
  const toast = useToast();
  const [form, setForm] = React.useState<Settings | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (data?.settings) setForm(data.settings);
  }, [data]);

  if (error) return <ErrorState message={error} onRetry={reload} />;

  const set = (patch: Partial<Settings>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      await api.patch("/api/admin/settings", {
        routingStrategy: form.routingStrategy,
        circuitThreshold: Number(form.circuitThreshold),
        circuitCooldownSeconds: Number(form.circuitCooldownSeconds),
        logRetentionDays: Number(form.logRetentionDays),
        defaultRateLimitPerMin: Number(form.defaultRateLimitPerMin),
        defaultMaxConcurrent: Number(form.defaultMaxConcurrent),
        quotaWarnPercent: Number(form.quotaWarnPercent),
        gatewayPublicUrl: form.gatewayPublicUrl || null,
        defaultModel: form.defaultModel
      });
      toast("Settings saved", "success");
      reload();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not save the settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Routing, resilience, limits, and retention." />

      {loading || !form ? (
        <Skeleton className="h-96" />
      ) : (
        <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Routing" description="How a request picks its upstream provider." />
            <div className="space-y-4 px-5 pb-5 pt-4">
              <Field
                label="Strategy"
                hint="Priority tries the lowest number first; round-robin rotates evenly; weighted samples by weight."
              >
                <Select
                  value={form.routingStrategy}
                  onChange={(event) => set({ routingStrategy: event.target.value as Settings["routingStrategy"] })}
                >
                  <option value="PRIORITY">Priority — deterministic order</option>
                  <option value="ROUND_ROBIN">Round-robin — even rotation</option>
                  <option value="WEIGHTED">Weighted — proportional to weight</option>
                </Select>
              </Field>
              <Field label="Default model" hint="Used when a client omits the model field.">
                <Input value={form.defaultModel} onChange={(event) => set({ defaultModel: event.target.value })} />
              </Field>
              <Field
                label="Public gateway URL"
                hint="Baked into generated Codex configs. Leave empty to use PUBLIC_GATEWAY_URL from the environment."
              >
                <Input
                  type="url"
                  value={form.gatewayPublicUrl ?? ""}
                  onChange={(event) => set({ gatewayPublicUrl: event.target.value })}
                  placeholder="https://gateway.example.com"
                />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Resilience"
              description="When to take a failing provider out of rotation, and for how long."
            />
            <div className="space-y-4 px-5 pb-5 pt-4">
              <Field label="Circuit threshold" hint="Consecutive failures before a provider is skipped.">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={form.circuitThreshold}
                  onChange={(event) => set({ circuitThreshold: Number(event.target.value) })}
                />
              </Field>
              <Field label="Cooldown (seconds)" hint="How long the circuit stays open before the provider is retried.">
                <Input
                  type="number"
                  min={5}
                  value={form.circuitCooldownSeconds}
                  onChange={(event) => set({ circuitCooldownSeconds: Number(event.target.value) })}
                />
              </Field>
              <p className="rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)]/50 px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                A successful health check also closes an open circuit early, so a provider that recovers rejoins
                the pool without waiting out the full cooldown.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Default limits" description="Applied to any key that does not set its own." />
            <div className="space-y-4 px-5 pb-5 pt-4">
              <Field label="Requests per minute">
                <Input
                  type="number"
                  min={1}
                  value={form.defaultRateLimitPerMin}
                  onChange={(event) => set({ defaultRateLimitPerMin: Number(event.target.value) })}
                />
              </Field>
              <Field label="Concurrent requests">
                <Input
                  type="number"
                  min={1}
                  value={form.defaultMaxConcurrent}
                  onChange={(event) => set({ defaultMaxConcurrent: Number(event.target.value) })}
                />
              </Field>
              <Field
                label="Quota warning threshold (%)"
                hint="Users see an amber warning below this much remaining, and red below half of it."
              >
                <Input
                  type="number"
                  min={1}
                  max={90}
                  value={form.quotaWarnPercent}
                  onChange={(event) => set({ quotaWarnPercent: Number(event.target.value) })}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Retention" description="How long request and audit history is kept." />
            <div className="space-y-4 px-5 pb-5 pt-4">
              <Field
                label="Log retention (days)"
                hint="Usage logs and audit entries older than this are deleted by the periodic sweep."
                error={formError ?? undefined}
              >
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  value={form.logRetentionDays}
                  onChange={(event) => set({ logRetentionDays: Number(event.target.value) })}
                />
              </Field>
              <p className="rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)]/50 px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                Quota balances and token transactions are never swept — only request and audit logs are.
                Deleting history does not restore anyone&apos;s tokens.
              </p>
            </div>
          </Card>

          <div className="lg:col-span-2">
            <Button type="submit" variant="primary" loading={saving}>
              Save settings
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
