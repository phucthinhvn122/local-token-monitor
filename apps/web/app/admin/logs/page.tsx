"use client";

import * as React from "react";
import type { ProviderView, UsageLogView } from "@cgw/shared";
import { qs } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { PageHeader } from "@/components/shell";
import { Card, Select } from "@/components/ui";
import { EMPTY_FILTERS, LogFilterBar, LogTable, toIsoEnd, toIsoStart, type LogFilters } from "@/components/log-table";

interface LogsResponse {
  total: number;
  page: number;
  pageSize: number;
  items: UsageLogView[];
}

const PAGE_SIZE = 50;

export default function AdminLogsPage() {
  const [filters, setFilters] = React.useState<LogFilters>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);

  const providers = useApi<{ items: ProviderView[] }>("/api/admin/providers");

  const params = {
    from: toIsoStart(filters.from),
    to: toIsoEnd(filters.to),
    model: filters.model,
    status: filters.status,
    sessionId: filters.sessionId,
    providerId: filters.providerId
  };

  const logs = useApi<LogsResponse>(`/api/admin/logs${qs({ ...params, page, pageSize: PAGE_SIZE })}`);

  const updateFilters = (next: LogFilters) => {
    setFilters(next);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Request logs"
        description="Every request through the gateway: who called, when, what it cost, and which provider served it."
      />

      <Card>
        <LogFilterBar
          filters={filters}
          onChange={updateFilters}
          onExport={() => (window.location.href = `/api/admin/logs/export${qs(params)}`)}
          extra={
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-faint)]">Provider</span>
              <Select
                className="h-8 w-44 text-[12px]"
                value={filters.providerId ?? ""}
                onChange={(event) => updateFilters({ ...filters, providerId: event.target.value || undefined })}
              >
                <option value="">All providers</option>
                {(providers.data?.items ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </Select>
            </label>
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
          showOwner
        />
      </Card>
    </>
  );
}
