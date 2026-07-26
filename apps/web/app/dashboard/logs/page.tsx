"use client";

import * as React from "react";
import type { UsageLogView } from "@cgw/shared";
import { qs } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { PageHeader } from "@/components/shell";
import { Card, CardHeader, EmptyState, Skeleton } from "@/components/ui";
import { EMPTY_FILTERS, LogFilterBar, LogTable, toIsoEnd, toIsoStart, type LogFilters } from "@/components/log-table";
import { formatDateTime, formatNumber } from "@/lib/utils";

interface LogsResponse {
  total: number;
  page: number;
  pageSize: number;
  items: UsageLogView[];
}

interface SessionsResponse {
  items: Array<{
    sessionId: string | null;
    requests: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    startedAt: string | null;
    endedAt: string | null;
  }>;
}

const PAGE_SIZE = 50;

export default function MyLogsPage() {
  const [filters, setFilters] = React.useState<LogFilters>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);

  const query = qs({
    from: toIsoStart(filters.from),
    to: toIsoEnd(filters.to),
    model: filters.model,
    status: filters.status,
    sessionId: filters.sessionId,
    page,
    pageSize: PAGE_SIZE
  });

  const logs = useApi<LogsResponse>(`/api/me/logs${query}`);
  const sessions = useApi<SessionsResponse>("/api/me/sessions");

  // Any filter change invalidates the current page number.
  const updateFilters = (next: LogFilters) => {
    setFilters(next);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="My requests"
        description="Every call your keys made through the gateway, with the tokens it cost."
      />

      <Card className="mb-4">
        <LogFilterBar
          filters={filters}
          onChange={updateFilters}
          onExport={() =>
            (window.location.href = `/api/me/logs/export${qs({
              from: toIsoStart(filters.from),
              to: toIsoEnd(filters.to)
            })}`)
          }
        />
        <LogTable
          logs={logs.data?.items ?? []}
          loading={logs.loading}
          error={logs.error}
          total={logs.data?.total ?? 0}
          page={page}
          pageSize={PAGE_SIZE}
          onPage={setPage}
          onRetry={logs.reload}
        />
      </Card>

      <Card>
        <CardHeader
          title="Working sessions"
          description="Requests grouped by the conversation id Codex sends, when it sends one."
        />
        <div className="px-5 pb-5 pt-4">
          {sessions.loading ? (
            <Skeleton className="h-24" />
          ) : (sessions.data?.items ?? []).length === 0 ? (
            <EmptyState
              title="No grouped sessions yet"
              description="Sessions appear once the client sends a conversation identifier with its requests."
            />
          ) : (
            <div className="space-y-2">
              {sessions.data!.items.map((session) => (
                <button
                  key={session.sessionId}
                  onClick={() => updateFilters({ ...filters, sessionId: session.sessionId ?? "" })}
                  className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5 text-left transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="min-w-0">
                    <code className="block truncate font-mono text-[12px]">{session.sessionId}</code>
                    <span className="text-[11px] text-[var(--text-faint)]">
                      {formatDateTime(session.startedAt)} → {formatDateTime(session.endedAt)}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-4 text-[12px]">
                    <span className="tabular">
                      <span className="text-[var(--text-faint)]">requests </span>
                      {formatNumber(session.requests)}
                    </span>
                    <span className="tabular font-medium">
                      <span className="text-[var(--text-faint)]">tokens </span>
                      {formatNumber(session.totalTokens)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
