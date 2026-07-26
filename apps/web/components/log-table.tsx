"use client";

import * as React from "react";
import { Download } from "lucide-react";
import type { UsageLogView } from "@cgw/shared";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/utils";
import { Badge, Button, EmptyState, ErrorState, Input, Pagination, Select, Skeleton, Table, Td, Th } from "@/components/ui";

export interface LogFilters {
  from: string;
  to: string;
  model: string;
  status: "" | "success" | "error";
  sessionId: string;
  providerId?: string;
  userId?: string;
}

export const EMPTY_FILTERS: LogFilters = {
  from: "",
  to: "",
  model: "",
  status: "",
  sessionId: ""
};

/** Filters live in one row above the table, never in a modal. */
export function LogFilterBar({
  filters,
  onChange,
  onExport,
  extra
}: {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  onExport: () => void;
  extra?: React.ReactNode;
}) {
  const set = (patch: Partial<LogFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-[var(--border)] px-4 py-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-faint)]">From</span>
        <Input
          type="date"
          className="h-8 w-[9.5rem] text-[12px]"
          value={filters.from}
          onChange={(event) => set({ from: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-faint)]">To</span>
        <Input
          type="date"
          className="h-8 w-[9.5rem] text-[12px]"
          value={filters.to}
          onChange={(event) => set({ to: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-faint)]">Model</span>
        <Input
          className="h-8 w-40 text-[12px]"
          placeholder="gpt-5-codex"
          value={filters.model}
          onChange={(event) => set({ model: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-faint)]">Status</span>
        <Select
          className="h-8 w-28 text-[12px]"
          value={filters.status}
          onChange={(event) => set({ status: event.target.value as LogFilters["status"] })}
        >
          <option value="">All</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </Select>
      </label>
      {extra}
      <div className="ml-auto flex gap-2">
        <Button size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
          Reset
        </Button>
        <Button size="sm" onClick={onExport}>
          <Download className="h-3.5 w-3.5" />
          CSV
        </Button>
      </div>
    </div>
  );
}

export type LogSortKey = "createdAt" | "totalTokens" | "latencyMs";

export function LogTable({
  logs,
  loading,
  error,
  total,
  page,
  pageSize,
  onPage,
  onRetry,
  showOwner = false,
  sort,
  order,
  onSort
}: {
  logs: UsageLogView[];
  loading: boolean;
  error: string | null;
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onRetry: () => void;
  showOwner?: boolean;
  sort?: LogSortKey;
  order?: "asc" | "desc";
  onSort?: (key: LogSortKey) => void;
}) {
  const sortProps = (key: LogSortKey) =>
    onSort
      ? { sortable: true, active: sort === key, direction: order, onSort: () => onSort(key) }
      : {};
  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-9" />
        ))}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <EmptyState
        title="No requests match these filters"
        description="Widen the date range, or clear the filters to see everything."
      />
    );
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th {...sortProps("createdAt")}>Time</Th>
            {showOwner && <Th>User</Th>}
            <Th>Model</Th>
            {showOwner && <Th>Provider</Th>}
            <Th className="text-right">Input</Th>
            <Th className="text-right">Output</Th>
            <Th className="text-right" {...sortProps("totalTokens")}>
              Total
            </Th>
            <Th className="text-right" {...sortProps("latencyMs")}>
              Latency
            </Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const failed = log.statusCode >= 400 || log.statusCode === 0;
            return (
              <tr key={log.id} className="transition-colors hover:bg-[var(--bg-subtle)]/50">
                <Td className="whitespace-nowrap text-[12px] text-[var(--text-muted)]">
                  {formatDateTime(log.createdAt)}
                </Td>
                {showOwner && (
                  <Td className="max-w-[14rem] truncate text-[12px]" >
                    <span title={log.userEmail ?? ""}>{log.userEmail ?? "—"}</span>
                  </Td>
                )}
                <Td className="font-mono text-[12px]">{log.model ?? "—"}</Td>
                {showOwner && <Td className="text-[12px]">{log.providerName ?? "—"}</Td>}
                <Td className="tabular text-right text-[12px]">{formatNumber(log.inputTokens)}</Td>
                <Td className="tabular text-right text-[12px]">{formatNumber(log.outputTokens)}</Td>
                <Td className="tabular text-right text-[12px] font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {formatNumber(log.totalTokens)}
                    {log.accuracy === "estimated" && (
                      <span
                        title="The provider did not report usage; this is a local estimate."
                        className="text-[10px] text-[var(--color-warning)]"
                      >
                        est
                      </span>
                    )}
                  </span>
                </Td>
                <Td className="tabular text-right text-[12px] text-[var(--text-muted)]">
                  {formatDuration(log.latencyMs)}
                </Td>
                <Td>
                  <Badge tone={failed ? "critical" : "safe"}>
                    {log.statusCode === 0 ? "failed" : log.statusCode}
                  </Badge>
                  {log.streamed && (
                    <Badge tone="neutral" className="ml-1">
                      stream
                    </Badge>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Pagination page={page} pageSize={pageSize} total={total} onPage={onPage} />
    </>
  );
}

/** Turn a `YYYY-MM-DD` input value into the ISO instant the API expects. */
export function toIsoStart(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00`).toISOString() : undefined;
}

export function toIsoEnd(value: string): string | undefined {
  return value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined;
}
