"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, KeyRound, Terminal } from "lucide-react";
import type { QuotaSummary, TimeseriesPoint } from "@cgw/shared";
import { useApi } from "@/lib/use-api";
import { formatDateTime, formatRelative, formatTokens, QUOTA_TEXT_CLASS } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { ProgressBar, ProgressRing, StatTile, UsageAreaChart } from "@/components/charts";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui";

type Range = "24h" | "7d" | "30d";

interface DashboardKey {
  id: string;
  name: string;
  maskedKey: string;
  status: "ACTIVE" | "REVOKED";
  tokenQuota: number;
  tokenUsed: number;
  tokenRemaining: number;
  usedPercent: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  setupAvailable: boolean;
}

interface DashboardResponse {
  quota: QuotaSummary;
  warnPercent: number;
  requestsLast24h: number;
  timeseries: TimeseriesPoint[];
  keys: DashboardKey[];
}

const RANGES: Range[] = ["24h", "7d", "30d"];

export default function UserDashboard() {
  const [range, setRange] = React.useState<Range>("30d");
  const { data, error, loading, reload } = useApi<DashboardResponse>(`/api/me/dashboard?range=${range}`);

  if (error) return <ErrorState message={error} onRetry={reload} />;

  const quota = data?.quota;
  const bucket = range === "24h" ? "hour" : "day";
  const trend = (data?.timeseries ?? []).map((point) => ({ value: point.totalTokens }));

  return (
    <>
      <PageHeader
        title="Your usage"
        description="Token quota, consumption trend, and the keys issued to you."
        action={
          <Link href="/dashboard/connect">
            <Button variant="primary">
              <Terminal className="h-4 w-4" />
              Connect Codex CLI
            </Button>
          </Link>
        }
      />

      {/* Quota warning banner — the most consequential state on this page. */}
      {quota && (quota.level === "warning" || quota.level === "critical" || quota.level === "depleted") && (
        <div
          role="alert"
          className={`mb-6 flex items-start gap-3 rounded-[var(--radius-card)] border px-4 py-3 ${
            quota.level === "warning"
              ? "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10"
              : "border-[var(--color-critical)]/40 bg-[var(--color-critical)]/10"
          }`}
        >
          <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${QUOTA_TEXT_CLASS[quota.level]}`} />
          <div className="text-[13px]">
            <p className={`font-medium ${QUOTA_TEXT_CLASS[quota.level]}`}>
              {quota.level === "depleted"
                ? "Your token quota is used up"
                : `Only ${formatTokens(quota.tokenRemaining)} tokens left`}
            </p>
            <p className="mt-0.5 text-[var(--text-muted)]">
              {quota.level === "depleted"
                ? "New requests are rejected until an administrator tops up your key."
                : `That is ${(100 - quota.usedPercent).toFixed(1)}% of your grant. Ask an administrator to top up before it runs out.`}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="flex flex-col items-center p-6">
          {loading || !quota ? (
            <Skeleton className="h-[148px] w-[148px] rounded-full" />
          ) : (
            <>
              <ProgressRing
                percent={quota.usedPercent}
                level={quota.level}
                label={`${Math.round(quota.usedPercent)}%`}
                sublabel="used"
              />
              <p className="tabular mt-4 text-lg font-semibold">{formatTokens(quota.tokenRemaining)}</p>
              <p className="text-[12px] text-[var(--text-muted)]">tokens remaining</p>

              <div className="mt-5 w-full space-y-2 border-t border-[var(--border)] pt-4 text-[13px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Granted</span>
                  <span className="tabular font-medium">{formatTokens(quota.tokenQuota)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Used</span>
                  <span className="tabular font-medium">{formatTokens(quota.tokenUsed)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Daily burn</span>
                  <span className="tabular font-medium">{formatTokens(quota.dailyBurnRate)}/day</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Runway</span>
                  <span className={`tabular font-medium ${QUOTA_TEXT_CLASS[quota.level]}`}>
                    {quota.estimatedDaysRemaining === null
                      ? "—"
                      : `~${quota.estimatedDaysRemaining} days`}
                  </span>
                </div>
              </div>
              {quota.estimatedDaysRemaining === null && (
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-faint)]">
                  A runway estimate appears once there is enough recent usage to measure a rate.
                </p>
              )}
            </>
          )}
        </Card>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile
              label="Requests / 24h"
              value={loading ? "—" : String(data?.requestsLast24h ?? 0)}
            />
            <StatTile
              label="Tokens used"
              value={loading ? "—" : formatTokens(quota?.tokenUsed ?? 0)}
              trend={trend}
            />
            <StatTile
              label="Active keys"
              value={loading ? "—" : String((data?.keys ?? []).filter((key) => key.status === "ACTIVE").length)}
            />
          </div>

          <Card>
            <CardHeader
              title="Token usage"
              description="Input and output tokens recorded by the gateway."
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
            <div className="px-5 pb-5 pt-4">
              {loading ? (
                <Skeleton className="h-[260px]" />
              ) : (data?.timeseries ?? []).every((point) => point.totalTokens === 0) ? (
                <EmptyState
                  title="No usage yet"
                  description="Connect Codex CLI to this gateway and your token usage will show up here."
                  action={
                    <Link href="/dashboard/connect">
                      <Button variant="primary" size="sm">
                        Set up Codex CLI
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  }
                />
              ) : (
                <UsageAreaChart data={data?.timeseries ?? []} bucket={bucket} />
              )}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-4">
        <CardHeader title="Your API keys" description="Full keys are shown only once, when they are issued." />
        <div className="px-5 pb-5 pt-4">
          {loading ? (
            <Skeleton className="h-20" />
          ) : (data?.keys ?? []).length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API key yet"
              description="An administrator has to issue a key before you can use the gateway."
            />
          ) : (
            <div className="space-y-3">
              {data!.keys.map((key) => (
                <div
                  key={key.id}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)]/40 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{key.name}</span>
                        <Badge tone={key.status === "ACTIVE" ? "safe" : "critical"}>
                          {key.status === "ACTIVE" ? "Active" : "Revoked"}
                        </Badge>
                        {key.expiresAt && (
                          <Badge tone="neutral">Expires {formatDateTime(key.expiresAt)}</Badge>
                        )}
                      </div>
                      <code className="mt-1 block font-mono text-[12px] text-[var(--text-muted)]">
                        {key.maskedKey}
                      </code>
                    </div>
                    <div className="text-right">
                      <p className="tabular text-sm font-medium">
                        {formatTokens(key.tokenRemaining)}{" "}
                        <span className="text-[var(--text-faint)]">left</span>
                      </p>
                      <p className="text-[11px] text-[var(--text-faint)]">
                        Last used {formatRelative(key.lastUsedAt)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3">
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
                    <div className="mt-1.5 flex justify-between text-[11px] text-[var(--text-faint)]">
                      <span className="tabular">{formatTokens(key.tokenUsed)} used</span>
                      <span className="tabular">{formatTokens(key.tokenQuota)} granted</span>
                    </div>
                  </div>

                  {key.status === "ACTIVE" && (
                    <div className="mt-3">
                      {key.setupAvailable ? (
                        <Link href={`/dashboard/connect?apiKeyId=${key.id}`}>
                          <Button size="sm">
                            <Terminal className="h-3.5 w-3.5" />
                            Set up Codex CLI
                          </Button>
                        </Link>
                      ) : (
                        <p className="text-[11px] text-[var(--text-faint)]">
                          This key can no longer generate a config file. Ask an administrator to rotate it.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
