"use client";

import * as React from "react";
import { ClipboardList } from "lucide-react";
import { qs } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Skeleton,
  Table,
  Td,
  Th
} from "@/components/ui";

interface AuditRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  ip: string | null;
  adminEmail: string | null;
  createdAt: string;
}

interface AuditResponse {
  total: number;
  page: number;
  pageSize: number;
  items: AuditRow[];
}

const PAGE_SIZE = 50;

/** Destructive actions get a warm badge so they stand out when scanning. */
function actionTone(action: string): "critical" | "warning" | "neutral" {
  if (action === "provider.circuit_open") return "critical";
  if (action.endsWith(".delete") || action.endsWith(".revoke")) return "critical";
  if (action.endsWith(".create") || action.endsWith(".topup") || action.startsWith("settings")) return "warning";
  return "neutral";
}

export default function AdminAuditPage() {
  const [action, setAction] = React.useState("");
  const [page, setPage] = React.useState(1);

  const { data, error, loading, reload } = useApi<AuditResponse>(
    `/api/admin/audit${qs({ action, page, pageSize: PAGE_SIZE })}`
  );

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every administrative action, with the actor and the payload that produced it."
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Input
            placeholder="Filter by exact action, e.g. apikey.create"
            className="h-8 max-w-xs text-[12px]"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setPage(1);
            }}
          />
        </div>

        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-9" />
            ))}
          </div>
        ) : (data?.items ?? []).length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Nothing recorded yet"
            description="Administrative actions appear here as soon as they happen."
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Admin</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {data!.items.map((row) => (
                  <tr key={row.id} className="align-top transition-colors hover:bg-[var(--bg-subtle)]/50">
                    <Td className="whitespace-nowrap text-[12px] text-[var(--text-muted)]">
                      {formatDateTime(row.createdAt)}
                    </Td>
                    <Td className="max-w-[14rem] truncate text-[12px]">{row.adminEmail ?? "system"}</Td>
                    <Td>
                      <Badge tone={actionTone(row.action)}>{row.action}</Badge>
                    </Td>
                    <Td className="text-[12px]">
                      <span className="text-[var(--text-muted)]">{row.targetType}</span>
                      {row.targetId && (
                        <code className="ml-1.5 font-mono text-[11px] text-[var(--text-faint)]">
                          {row.targetId.slice(0, 8)}…
                        </code>
                      )}
                    </Td>
                    <Td className="max-w-sm">
                      {row.metadata ? (
                        <code className="block truncate font-mono text-[11px] text-[var(--text-faint)]">
                          {JSON.stringify(row.metadata)}
                        </code>
                      ) : (
                        <span className="text-[11px] text-[var(--text-faint)]">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
