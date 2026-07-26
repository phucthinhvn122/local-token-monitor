"use client";

import * as React from "react";
import Link from "next/link";
import { Server } from "lucide-react";
import type { ProviderView, TimeseriesPoint } from "@cgw/shared";
import { useApi } from "@/lib/use-api";
import { formatNumber, formatRelative, formatTokens } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { RequestsBarChart, StatTile, UsageAreaChart } from "@/components/charts";
import { ProviderHealthBadge } from "@/components/provider-health";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton, Table, Td, Th } from "@/components/ui";

type Range = "24h" | "7d" | "30d" | "90d";

interface OverviewResponse {
  totals: {
    users: number;
    activeUsers: number;
    apiKeys: number;
    activeApiKeys: number;
    tokensGranted: number;
    tokensUsed: number;
    requestsInRange: number;
    errorsInRange: number;
    errorRate: number;
  };
  timeseries: TimeseriesPoint[];
  providers: ProviderView[];
  routingStrategy: string;
  topUsers: Array<{
    apiKeyId: string | null;
    email: string;
    name: string | null;
    keyPrefix: string | null;
    totalTokens: number;
    requests: number;
  }>;
}

const RANGES: Range[] = ["24h", "7d", "30d", "90d"];

export default function AdminOverview() {
  const [range, setRange] = React.useState<Range>("30d");
  const { data, error, loading, reload } = useApi<OverviewResponse>(`/api/admin/overview?range=${range}`);

  if (error) return <ErrorState message={error} onRetry={reload} />;

  const totals = data?.totals;
  const bucket = range === "24h" ? "hour" : range === "90d" ? "week" : "day";
  const trend = (data?.timeseries ?? []).map((point) => ({ value: point.totalTokens }));
  const utilisation =
    totals && totals.tokensGranted > 0 ? (totals.tokensUsed / totals.tokensGranted) * 100 : 0;

  return (
    <>
      <PageHeader
        title="System overview"
        description="Fleet-wide usage, quota utilisation, and pool health."
        action={
          <div className="flex gap-1 rounded-lg border border-[var(--border)] p-0.5">
            {RANGES.map((option) => (
              <button
                key={option}
                onClick={() => setRange(option)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  range === option
                    ? "bg-[var(--bg-subtle)] text-[var(--text)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Users"
          value={loading ? "—" : formatNumber(totals?.users ?? 0)}
          hint={loading ? undefined : `${totals?.activeUsers ?? 0} active`}
        />
        <StatTile
          label="Tokens granted"
          value={loading ? "—" : formatTokens(totals?.tokensGranted ?? 0)}
          hint={loading ? undefined : `${totals?.activeApiKeys ?? 0} active keys`}
        />
        <StatTile
          label="Tokens used"
          value={loading ? "—" : formatTokens(totals?.tokensUsed ?? 0)}
          hint={loading ? undefined : `${utilisation.toFixed(1)}% of everything granted`}
          trend={trend}
        />
        <StatTile
          label={`Requests · ${range}`}
          value={loading ? "—" : formatNumber(totals?.requestsInRange ?? 0)}
          hint={loading ? undefined : `${totals?.errorRate ?? 0}% errored`}
          tone={totals && totals.errorRate > 5 ? "critical" : undefined}
        />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Token usage" description="Input and output across every key." />
          <div className="px-5 pb-5 pt-4">
            {loading ? <Skeleton className="h-[260px]" /> : <UsageAreaChart data={data?.timeseries ?? []} bucket={bucket} />}
          </div>
        </Card>

        <Card>
          <CardHeader title="Requests" description="Buckets containing a failed request are shown in red." />
          <div className="px-5 pb-5 pt-4">
            {loading ? (
              <Skeleton className="h-[200px]" />
            ) : (
              <RequestsBarChart data={data?.timeseries ?? []} bucket={bucket} />
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Pool providers"
            description={loading ? undefined : `Routing strategy: ${data?.routingStrategy.toLowerCase().replace("_", "-")}`}
            action={
              <Link href="/admin/providers" className="text-[13px] text-[var(--color-accent-400)] hover:underline">
                Manage
              </Link>
            }
          />
          <div className="pt-2">
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : (data?.providers ?? []).length === 0 ? (
              <EmptyState
                icon={Server}
                title="No pool providers yet"
                description="The gateway cannot serve traffic until at least one upstream provider is configured."
              />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>Provider</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Latency</Th>
                    <Th className="text-right">Checked</Th>
                  </tr>
                </thead>
                <tbody>
                  {data!.providers.map((provider) => (
                    <tr key={provider.id}>
                      <Td>
                        <span className="text-[13px] font-medium">{provider.name}</span>
                        <span className="ml-2 text-[11px] text-[var(--text-faint)]">
                          p{provider.priority} · {provider.wireApi.toLowerCase()}
                        </span>
                      </Td>
                      <Td>
                        <ProviderHealthBadge provider={provider} />
                      </Td>
                      <Td className="tabular text-right text-[12px] text-[var(--text-muted)]">
                        {provider.lastHealthLatency ? `${provider.lastHealthLatency}ms` : "—"}
                      </Td>
                      <Td className="text-right text-[12px] text-[var(--text-muted)]">
                        {formatRelative(provider.lastHealthCheck)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Top consumers" description="By tokens used in the last 30 days." />
          <div className="pt-2">
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : (data?.topUsers ?? []).length === 0 ? (
              <EmptyState title="No usage recorded yet" />
            ) : (
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>User</Th>
                    <Th className="text-right">Requests</Th>
                    <Th className="text-right">Tokens</Th>
                  </tr>
                </thead>
                <tbody>
                  {data!.topUsers.map((row) => (
                    <tr key={row.apiKeyId ?? row.email}>
                      <Td>
                        <span className="block truncate text-[13px]">{row.email}</span>
                        {row.keyPrefix && (
                          <code className="font-mono text-[11px] text-[var(--text-faint)]">
                            {row.keyPrefix}****
                          </code>
                        )}
                      </Td>
                      <Td className="tabular text-right text-[12px]">{formatNumber(row.requests)}</Td>
                      <Td className="tabular text-right text-[12px] font-medium">
                        {formatTokens(row.totalTokens)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
