"use client";

import * as React from "react";
import { AlertTriangle, Check, Copy, KeyRound, Plus, RefreshCw } from "lucide-react";
import type { ApiKeyView, TimeseriesPoint } from "@cgw/shared";
import { api, qs } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatDateTime, formatNumber, formatRelative, formatTokens } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { ProgressBar, UsageAreaChart } from "@/components/charts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Pagination,
  Select,
  SidePanel,
  Skeleton,
  Table,
  Td,
  Th,
  useToast
} from "@/components/ui";

interface KeysResponse {
  items: ApiKeyView[];
}

interface UsersResponse {
  items: Array<{ id: string; email: string; name: string | null }>;
}

interface KeyDetail {
  key: ApiKeyView;
  timeseries: TimeseriesPoint[];
  requestCount: number;
  avgLatencyMs: number;
  transactions: Array<{
    id: string;
    amount: number;
    type: string;
    note: string | null;
    adminEmail: string | null;
    createdAt: string;
  }>;
}

const PRESETS = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];

/**
 * Shown once, right after a key is issued. Deliberately loud and blocking:
 * this value is not recoverable from any other screen.
 */
function NewKeyReveal({ plaintext, onDone }: { plaintext: string; onDone: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
    } catch {
      toast("Clipboard unavailable — select the key and copy manually", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
        <p className="text-[13px] text-[var(--text-muted)]">
          Copy this key now. It is shown once and cannot be retrieved from this screen again — issue a new
          key or rotate this one if it is lost.
        </p>
      </div>

      <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg)] p-3">
        <code className="block break-all font-mono text-[13px]">{plaintext}</code>
      </div>

      <div className="flex gap-2">
        <Button variant="primary" onClick={copy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy key"}
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function CreateKeyForm({ onCreated }: { onCreated: (plaintext: string) => void }) {
  const users = useApi<UsersResponse>("/api/admin/users?pageSize=100");
  const toast = useToast();

  const [target, setTarget] = React.useState<"existing" | "new">("existing");
  const [userId, setUserId] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [keyName, setKeyName] = React.useState("Default key");
  const [tokenQuota, setTokenQuota] = React.useState("2000000");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [rateLimit, setRateLimit] = React.useState("0");
  const [maxConcurrent, setMaxConcurrent] = React.useState("0");
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ plaintext: string }>("/api/admin/keys", {
        ...(target === "existing"
          ? { userId }
          : { newUser: { email, name: name || undefined, password, role: "USER" } }),
        name: keyName,
        tokenQuota: Number(tokenQuota),
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
        rateLimitPerMin: Number(rateLimit),
        maxConcurrent: Number(maxConcurrent),
        note: note || undefined
      });
      toast("API key created", "success");
      onCreated(result.plaintext);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the key");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-[var(--border)] p-0.5">
        {(
          [
            ["existing", "Existing user"],
            ["new", "Create a user"]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTarget(id)}
            className={`flex-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
              target === id ? "bg-[var(--bg-subtle)]" : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {target === "existing" ? (
        <Field label="User">
          <Select required value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">Select a user…</option>
            {(users.data?.items ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.email}
                {user.name ? ` — ${user.name}` : ""}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <Field label="Email">
            <Input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teammate@example.com"
            />
          </Field>
          <Field label="Name" hint="Optional.">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Temporary password" hint="At least 10 characters. Share it out of band.">
            <Input
              type="text"
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </>
      )}

      <Field label="Key name">
        <Input required value={keyName} onChange={(event) => setKeyName(event.target.value)} />
      </Field>

      <Field label="Token quota" hint="A raw token count. No plans, no tiers.">
        <Input
          type="number"
          min={0}
          required
          value={tokenQuota}
          onChange={(event) => setTokenQuota(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setTokenQuota(String(preset))}
            className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          >
            {formatTokens(preset)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Rate limit / min" hint="0 uses the system default.">
          <Input type="number" min={0} value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} />
        </Field>
        <Field label="Max concurrent" hint="0 uses the system default.">
          <Input
            type="number"
            min={0}
            value={maxConcurrent}
            onChange={(event) => setMaxConcurrent(event.target.value)}
          />
        </Field>
      </div>

      <Field label="Expires" hint="Leave empty for a key that never expires.">
        <Input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
      </Field>

      <Field label="Note" hint="Recorded on the opening grant transaction." error={error ?? undefined}>
        <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Q3 allocation" />
      </Field>

      <Button type="submit" variant="primary" loading={submitting} className="w-full">
        Create key
      </Button>
    </form>
  );
}

function KeyDetailPanel({ apiKeyId, onChanged }: { apiKeyId: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<KeyDetail>(`/api/admin/keys/${apiKeyId}`);
  const toast = useToast();
  const [topUp, setTopUp] = React.useState("1000000");
  const [busy, setBusy] = React.useState(false);
  const [rotated, setRotated] = React.useState<string | null>(null);

  const act = async (run: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await run();
      toast(message, "success");
      reload();
      onChanged();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Action failed", "error");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton className="h-64" />;
  if (rotated) return <NewKeyReveal plaintext={rotated} onDone={() => setRotated(null)} />;

  const key = data.key;

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <code className="font-mono text-[13px]">{key.maskedKey}</code>
          <Badge tone={key.status === "ACTIVE" ? "safe" : "critical"}>{key.status}</Badge>
        </div>
        <ProgressBar
          percent={key.usedPercent}
          level={
            key.usedPercent >= 100
              ? "depleted"
              : key.usedPercent >= 95
                ? "critical"
                : key.usedPercent >= 90
                  ? "warning"
                  : "safe"
          }
        />
        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[12px]">
          <div>
            <p className="tabular font-medium">{formatTokens(key.tokenQuota)}</p>
            <p className="text-[var(--text-faint)]">granted</p>
          </div>
          <div>
            <p className="tabular font-medium">{formatTokens(key.tokenUsed)}</p>
            <p className="text-[var(--text-faint)]">used</p>
          </div>
          <div>
            <p className="tabular font-medium">{formatTokens(key.tokenRemaining)}</p>
            <p className="text-[var(--text-faint)]">remaining</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-[var(--border)] py-3 text-[12px]">
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Owner</span>
          <span className="truncate">{key.user?.email}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Requests</span>
          <span className="tabular">{formatNumber(data.requestCount)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Avg latency</span>
          <span className="tabular">{data.avgLatencyMs}ms</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Last used</span>
          <span>{formatRelative(key.lastUsedAt)}</span>
        </div>
      </div>

      <div>
        <p className="mb-2 text-[13px] font-medium">Usage · last 30 days</p>
        <UsageAreaChart data={data.timeseries} bucket="day" height={180} />
      </div>

      <div>
        <p className="mb-2 text-[13px] font-medium">Add tokens</p>
        <div className="flex gap-2">
          <Input
            type="number"
            min={1}
            value={topUp}
            onChange={(event) => setTopUp(event.target.value)}
            className="flex-1"
          />
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              act(
                () => api.post(`/api/admin/keys/${apiKeyId}/topup`, { amount: Number(topUp) }),
                `Added ${formatTokens(Number(topUp))} tokens`
              )
            }
          >
            Top up
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setTopUp(String(preset))}
              className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              +{formatTokens(preset)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[13px] font-medium">Transactions</p>
        <div className="max-h-56 space-y-1.5 overflow-y-auto">
          {data.transactions.length === 0 ? (
            <p className="text-[12px] text-[var(--text-faint)]">No transactions yet.</p>
          ) : (
            data.transactions.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 text-[12px]">
                <div className="min-w-0">
                  <span className="font-medium">{item.type}</span>
                  {item.note && <span className="ml-1.5 truncate text-[var(--text-faint)]">{item.note}</span>}
                  <span className="ml-1.5 text-[var(--text-faint)]">{formatRelative(item.createdAt)}</span>
                </div>
                <span
                  className={`tabular shrink-0 font-medium ${
                    item.amount >= 0 ? "text-[var(--color-safe)]" : "text-[var(--text-muted)]"
                  }`}
                >
                  {item.amount >= 0 ? "+" : ""}
                  {formatTokens(item.amount)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
        <Button
          loading={busy}
          onClick={() =>
            act(
              () =>
                api.patch(`/api/admin/keys/${apiKeyId}`, {
                  status: key.status === "ACTIVE" ? "REVOKED" : "ACTIVE"
                }),
              key.status === "ACTIVE" ? "Key revoked" : "Key reactivated"
            )
          }
        >
          {key.status === "ACTIVE" ? "Revoke" : "Reactivate"}
        </Button>
        <Button
          loading={busy}
          onClick={async () => {
            if (!confirm("Rotating replaces the secret. The old key stops working immediately. Continue?")) return;
            setBusy(true);
            try {
              const result = await api.post<{ plaintext: string }>(`/api/admin/keys/${apiKeyId}/rotate`);
              setRotated(result.plaintext);
              onChanged();
            } catch (caught) {
              toast(caught instanceof Error ? caught.message : "Rotation failed", "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Rotate
        </Button>
        <Button
          variant="danger"
          loading={busy}
          className="ml-auto"
          onClick={() => {
            if (!confirm("Delete this key and all of its usage history? This cannot be undone.")) return;
            void act(() => api.delete(`/api/admin/keys/${apiKeyId}`), "Key deleted");
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

const PAGE_SIZE = 20;

export default function AdminKeysPage() {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  const { data, error, loading, reload } = useApi<KeysResponse>(`/api/admin/keys${qs({ search, status })}`);

  const items = data?.items ?? [];
  const paged = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <PageHeader
        title="API keys"
        description="Issue keys, grant raw token quota, and top up existing keys."
        action={
          <Button
            variant="primary"
            onClick={() => {
              setCreated(null);
              setCreating(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New API key
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Input
            placeholder="Search by email, key prefix, or name…"
            className="h-8 max-w-xs text-[12px]"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <Select
            className="h-8 w-32 text-[12px]"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="REVOKED">Revoked</option>
          </Select>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Create a key to give someone access to the gateway."
            action={
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" />
                New API key
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Owner</Th>
                  <Th>Quota</Th>
                  <Th className="text-right">Remaining</Th>
                  <Th className="text-right">Last used</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {paged.map((key) => (
                  <tr
                    key={key.id}
                    onClick={() => setSelected(key.id)}
                    className="cursor-pointer transition-colors hover:bg-[var(--bg-subtle)]/50"
                  >
                    <Td>
                      <code className="font-mono text-[12px]">{key.maskedKey}</code>
                      <span className="ml-2 text-[11px] text-[var(--text-faint)]">{key.name}</span>
                    </Td>
                    <Td className="max-w-[16rem] truncate text-[12px]">{key.user?.email ?? "—"}</Td>
                    <Td className="w-44">
                      <ProgressBar
                        percent={key.usedPercent}
                        level={
                          key.usedPercent >= 100
                            ? "depleted"
                            : key.usedPercent >= 95
                              ? "critical"
                              : key.usedPercent >= 90
                                ? "warning"
                                : "safe"
                        }
                      />
                      <span className="tabular mt-1 block text-[11px] text-[var(--text-faint)]">
                        {formatTokens(key.tokenUsed)} / {formatTokens(key.tokenQuota)}
                      </span>
                    </Td>
                    <Td className="tabular text-right text-[12px] font-medium">
                      {formatTokens(key.tokenRemaining)}
                    </Td>
                    <Td className="text-right text-[12px] text-[var(--text-muted)]">
                      {formatRelative(key.lastUsedAt)}
                    </Td>
                    <Td>
                      <Badge tone={key.status === "ACTIVE" ? "safe" : "critical"}>{key.status}</Badge>
                      {key.expiresAt && new Date(key.expiresAt) < new Date() && (
                        <Badge tone="warning" className="ml-1">
                          expired
                        </Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={items.length} onPage={setPage} />
          </>
        )}
      </Card>

      <SidePanel
        open={creating}
        onClose={() => {
          setCreating(false);
          setCreated(null);
          reload();
        }}
        title={created ? "Key created" : "New API key"}
        description={created ? undefined : "Grant a raw token amount directly to a user."}
      >
        {created ? (
          <NewKeyReveal
            plaintext={created}
            onDone={() => {
              setCreating(false);
              setCreated(null);
              reload();
            }}
          />
        ) : (
          <CreateKeyForm onCreated={setCreated} />
        )}
      </SidePanel>

      <SidePanel
        open={selected !== null}
        onClose={() => {
          setSelected(null);
          reload();
        }}
        title="API key"
        description={selected ? formatDateTime(items.find((key) => key.id === selected)?.createdAt) : undefined}
      >
        {selected && <KeyDetailPanel apiKeyId={selected} onChanged={reload} />}
      </SidePanel>
    </>
  );
}
