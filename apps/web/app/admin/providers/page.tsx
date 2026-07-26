"use client";

import * as React from "react";
import { Plug, Plus, ServerCog } from "lucide-react";
import type { ProviderView } from "@cgw/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatNumber, formatRelative, formatTokens } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { ProviderHealthBadge } from "@/components/provider-health";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  SidePanel,
  Skeleton,
  Table,
  Td,
  Th,
  Toggle,
  useToast
} from "@/components/ui";

interface ProvidersResponse {
  items: ProviderView[];
}

const UNSAVED = "00000000-0000-0000-0000-000000000000";

interface FormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  wireApi: "CHAT" | "RESPONSES";
  priority: string;
  weight: string;
  models: string;
  isActive: boolean;
  timeoutMs: string;
}

const BLANK: FormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  wireApi: "CHAT",
  priority: "100",
  weight: "1",
  models: "",
  isActive: true,
  timeoutMs: "600000"
};

function ProviderForm({
  provider,
  onSaved,
  onDeleted
}: {
  provider: ProviderView | null;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState<FormState>(
    provider
      ? {
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: "",
          wireApi: provider.wireApi,
          priority: String(provider.priority),
          weight: String(provider.weight),
          models: provider.models.join(", "),
          isActive: provider.isActive,
          timeoutMs: String(provider.timeoutMs)
        }
      : BLANK
  );
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; message: string; latencyMs: number } | null>(
    null
  );
  const [error, setError] = React.useState<string | null>(null);

  const set = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const payload = () => ({
    name: form.name,
    baseUrl: form.baseUrl,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    wireApi: form.wireApi,
    priority: Number(form.priority),
    weight: Number(form.weight),
    models: form.models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
    isActive: form.isActive,
    timeoutMs: Number(form.timeoutMs)
  });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (provider) await api.patch(`/api/admin/providers/${provider.id}`, payload());
      else await api.post("/api/admin/providers", { ...payload(), apiKey: form.apiKey });
      toast(provider ? "Provider updated" : "Provider added", "success");
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the provider");
    } finally {
      setSaving(false);
    }
  };

  /**
   * Test against whatever is on screen. For an existing provider with the key
   * field left blank, the server falls back to the stored credential.
   */
  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; message: string; latencyMs: number }>(
        `/api/admin/providers/${provider?.id ?? UNSAVED}/test`,
        {
          baseUrl: form.baseUrl || undefined,
          apiKey: form.apiKey || undefined,
          wireApi: form.wireApi
        }
      );
      setTestResult(result);
    } catch (caught) {
      setTestResult({
        ok: false,
        message: caught instanceof Error ? caught.message : "Test failed",
        latencyMs: 0
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <Field label="Name">
        <Input required value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="Primary pool" />
      </Field>

      <Field label="Base URL" hint="With or without a trailing /v1 — both work.">
        <Input
          required
          type="url"
          value={form.baseUrl}
          onChange={(event) => set({ baseUrl: event.target.value })}
          placeholder="https://api.provider.com/v1"
        />
      </Field>

      <Field
        label="API key"
        hint={
          provider
            ? `Stored encrypted (${provider.apiKeyMasked}). Leave blank to keep the current key.`
            : "Encrypted with AES-256-GCM before it is stored. It is never returned by the API."
        }
      >
        <Input
          type="password"
          required={!provider}
          value={form.apiKey}
          onChange={(event) => set({ apiKey: event.target.value })}
          placeholder={provider ? "••••••••" : "sk-…"}
        />
      </Field>

      <Field label="Wire API" hint="Chat Completions suits most self-built and proxy providers.">
        <Select value={form.wireApi} onChange={(event) => set({ wireApi: event.target.value as FormState["wireApi"] })}>
          <option value="CHAT">chat — /v1/chat/completions</option>
          <option value="RESPONSES">responses — /v1/responses</option>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Priority" hint="Lower is tried first.">
          <Input type="number" min={0} value={form.priority} onChange={(event) => set({ priority: event.target.value })} />
        </Field>
        <Field label="Weight" hint="Share under weighted routing.">
          <Input type="number" min={1} value={form.weight} onChange={(event) => set({ weight: event.target.value })} />
        </Field>
      </div>

      <Field label="Model allow-list" hint="Comma separated. Leave empty to accept every model.">
        <Input
          value={form.models}
          onChange={(event) => set({ models: event.target.value })}
          placeholder="gpt-5-codex, gpt-4o"
        />
      </Field>

      <Field label="Timeout (ms)" hint="Codex sessions are long; 600000 is 10 minutes.">
        <Input
          type="number"
          min={1000}
          value={form.timeoutMs}
          onChange={(event) => set({ timeoutMs: event.target.value })}
        />
      </Field>

      <div className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium">Active</p>
          <p className="text-[11px] text-[var(--text-faint)]">Inactive providers are skipped by the router.</p>
        </div>
        <Toggle checked={form.isActive} onChange={(value) => set({ isActive: value })} label="Provider active" />
      </div>

      {testResult && (
        <div
          className={`rounded-lg border px-3 py-2.5 text-[12px] ${
            testResult.ok
              ? "border-[var(--color-safe)]/40 bg-[var(--color-safe)]/10 text-[var(--color-safe)]"
              : "border-[var(--color-critical)]/40 bg-[var(--color-critical)]/10 text-[var(--color-critical)]"
          }`}
        >
          {testResult.message}
          {testResult.latencyMs > 0 && <span className="ml-1 opacity-70">({testResult.latencyMs}ms)</span>}
        </div>
      )}

      {error && <p className="text-[12px] text-[var(--color-critical)]">{error}</p>}

      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
        <Button type="submit" variant="primary" loading={saving}>
          {provider ? "Save changes" : "Add provider"}
        </Button>
        <Button type="button" loading={testing} onClick={test} disabled={!form.baseUrl}>
          <Plug className="h-3.5 w-3.5" />
          Test connection
        </Button>
        {provider && (
          <Button
            type="button"
            variant="danger"
            className="ml-auto"
            onClick={async () => {
              if (!confirm(`Remove "${provider.name}" from the pool?`)) return;
              await api.delete(`/api/admin/providers/${provider.id}`);
              toast("Provider removed", "success");
              onDeleted();
            }}
          >
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}

export default function AdminProvidersPage() {
  const { data, error, loading, reload } = useApi<ProvidersResponse>("/api/admin/providers");
  const [editing, setEditing] = React.useState<ProviderView | null>(null);
  const [creating, setCreating] = React.useState(false);

  const providers = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Pool providers"
        description="Upstream OpenAI-compatible services the gateway forwards to."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Add provider
          </Button>
        }
      />

      <Card>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : providers.length === 0 ? (
          <EmptyState
            icon={ServerCog}
            title="No pool providers configured"
            description="The gateway returns 503 to every request until at least one upstream provider is active."
            action={
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add your first provider
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Health</Th>
                <Th className="text-right">Requests 24h</Th>
                <Th className="text-right">Error rate</Th>
                <Th className="text-right">Tokens 24h</Th>
                <Th className="text-right">Avg latency</Th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr
                  key={provider.id}
                  onClick={() => setEditing(provider)}
                  className="cursor-pointer transition-colors hover:bg-[var(--bg-subtle)]/50"
                >
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">{provider.name}</span>
                      <Badge tone="neutral">{provider.wireApi.toLowerCase()}</Badge>
                      <Badge tone="neutral">p{provider.priority}</Badge>
                      {provider.weight > 1 && <Badge tone="neutral">w{provider.weight}</Badge>}
                    </div>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--text-faint)]">
                      {provider.baseUrl} · {provider.apiKeyMasked}
                    </span>
                    {provider.lastErrorMessage && !provider.lastHealthOk && (
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--color-critical)]">
                        {provider.lastErrorMessage} · {formatRelative(provider.lastErrorAt)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <ProviderHealthBadge provider={provider} />
                    {provider.consecutiveErrors > 0 && (
                      <span className="ml-1.5 text-[11px] text-[var(--text-faint)]">
                        {provider.consecutiveErrors} in a row
                      </span>
                    )}
                  </Td>
                  <Td className="tabular text-right text-[12px]">{formatNumber(provider.stats?.requests ?? 0)}</Td>
                  <Td className="tabular text-right text-[12px]">
                    <span
                      className={
                        (provider.stats?.errorRate ?? 0) > 5 ? "text-[var(--color-critical)]" : undefined
                      }
                    >
                      {provider.stats?.errorRate ?? 0}%
                    </span>
                  </Td>
                  <Td className="tabular text-right text-[12px]">{formatTokens(provider.stats?.totalTokens ?? 0)}</Td>
                  <Td className="tabular text-right text-[12px] text-[var(--text-muted)]">
                    {provider.stats?.avgLatencyMs ?? 0}ms
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <SidePanel
        open={creating}
        onClose={() => setCreating(false)}
        title="Add pool provider"
        description="Credentials are encrypted before they touch the database."
      >
        <ProviderForm
          provider={null}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
          onDeleted={() => setCreating(false)}
        />
      </SidePanel>

      <SidePanel
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.name ?? "Provider"}
        description={editing?.baseUrl}
      >
        {editing && (
          <ProviderForm
            key={editing.id}
            provider={editing}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
            onDeleted={() => {
              setEditing(null);
              reload();
            }}
          />
        )}
      </SidePanel>
    </>
  );
}
