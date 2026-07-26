"use client";

import * as React from "react";
import { Plus, Users } from "lucide-react";
import { api, qs } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatRelative, formatTokens } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
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

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "SUSPENDED";
  lastLoginAt: string | null;
  createdAt: string;
  keyCount: number;
  activeKeyCount: number;
  tokenQuota: number;
  tokenUsed: number;
}

interface UsersResponse {
  total: number;
  page: number;
  pageSize: number;
  items: UserRow[];
}

const PAGE_SIZE = 20;

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<"USER" | "ADMIN">("USER");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/admin/users", { email, name: name || undefined, password, role });
      toast("User created", "success");
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the user");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email">
        <Input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
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
      <Field label="Role" error={error ?? undefined}>
        <Select value={role} onChange={(event) => setRole(event.target.value as "USER" | "ADMIN")}>
          <option value="USER">Member</option>
          <option value="ADMIN">Administrator</option>
        </Select>
      </Field>
      <Button type="submit" variant="primary" loading={submitting} className="w-full">
        Create user
      </Button>
    </form>
  );
}

function EditUserForm({ user, onChanged }: { user: UserRow; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = React.useState(user.name ?? "");
  const [role, setRole] = React.useState(user.role);
  const [status, setStatus] = React.useState(user.status);
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/admin/users/${user.id}`, {
        name: name || null,
        role,
        status,
        ...(password ? { password } : {})
      });
      toast("User updated", "success");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the user");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-[var(--border)] p-3 text-[12px]">
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Keys</span>
          <span className="tabular">
            {user.activeKeyCount} / {user.keyCount}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Last login</span>
          <span>{formatRelative(user.lastLoginAt)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Granted</span>
          <span className="tabular">{formatTokens(user.tokenQuota)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Used</span>
          <span className="tabular">{formatTokens(user.tokenUsed)}</span>
        </div>
      </div>

      <Field label="Name">
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Role">
        <Select value={role} onChange={(event) => setRole(event.target.value as UserRow["role"])}>
          <option value="USER">Member</option>
          <option value="ADMIN">Administrator</option>
        </Select>
      </Field>
      <Field label="Status" hint="Suspending signs the user out and blocks their keys immediately.">
        <Select value={status} onChange={(event) => setStatus(event.target.value as UserRow["status"])}>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
        </Select>
      </Field>
      <Field
        label="Reset password"
        hint="Leave empty to keep the current one. Setting it signs the user out everywhere."
        error={error ?? undefined}
      >
        <Input
          type="text"
          minLength={10}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="New password"
        />
      </Field>

      <div className="flex gap-2 border-t border-[var(--border)] pt-4">
        <Button type="submit" variant="primary" loading={busy}>
          Save changes
        </Button>
        <Button
          type="button"
          variant="danger"
          className="ml-auto"
          onClick={async () => {
            if (!confirm(`Delete ${user.email}? Their keys and usage history go with them.`)) return;
            try {
              await api.delete(`/api/admin/users/${user.id}`);
              toast("User deleted", "success");
              onChanged();
            } catch (caught) {
              toast(caught instanceof Error ? caught.message : "Delete failed", "error");
            }
          }}
        >
          Delete user
        </Button>
      </div>
    </form>
  );
}

export default function AdminUsersPage() {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<UserRow | null>(null);

  const { data, error, loading, reload } = useApi<UsersResponse>(
    `/api/admin/users${qs({ search, status, page, pageSize: PAGE_SIZE })}`
  );

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts that can sign in to the dashboard and hold API keys."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New user
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Input
            placeholder="Search by email or name…"
            className="h-8 max-w-xs text-[12px]"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <Select
            className="h-8 w-36 text-[12px]"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
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
        ) : (data?.items ?? []).length === 0 ? (
          <EmptyState
            icon={Users}
            title="No users match"
            description="Adjust the filters, or create a user to get started."
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th className="text-right">Keys</Th>
                  <Th className="text-right">Granted</Th>
                  <Th className="text-right">Used</Th>
                  <Th className="text-right">Last login</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data!.items.map((user) => (
                  <tr
                    key={user.id}
                    onClick={() => setEditing(user)}
                    className="cursor-pointer transition-colors hover:bg-[var(--bg-subtle)]/50"
                  >
                    <Td>
                      <span className="block text-[13px]">{user.email}</span>
                      {user.name && <span className="text-[11px] text-[var(--text-faint)]">{user.name}</span>}
                    </Td>
                    <Td>
                      <Badge tone={user.role === "ADMIN" ? "accent" : "neutral"}>
                        {user.role === "ADMIN" ? "Admin" : "Member"}
                      </Badge>
                    </Td>
                    <Td className="tabular text-right text-[12px]">
                      {user.activeKeyCount}
                      <span className="text-[var(--text-faint)]">/{user.keyCount}</span>
                    </Td>
                    <Td className="tabular text-right text-[12px]">{formatTokens(user.tokenQuota)}</Td>
                    <Td className="tabular text-right text-[12px]">{formatTokens(user.tokenUsed)}</Td>
                    <Td className="text-right text-[12px] text-[var(--text-muted)]">
                      {formatRelative(user.lastLoginAt)}
                    </Td>
                    <Td>
                      <Badge tone={user.status === "ACTIVE" ? "safe" : "warning"}>
                        {user.status === "ACTIVE" ? "Active" : "Suspended"}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={data?.total ?? 0}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      <SidePanel open={creating} onClose={() => setCreating(false)} title="New user">
        <CreateUserForm
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      </SidePanel>

      <SidePanel
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.email ?? "User"}
        description={editing ? `Created ${formatRelative(editing.createdAt)}` : undefined}
      >
        {editing && (
          <EditUserForm
            key={editing.id}
            user={editing}
            onChanged={() => {
              setEditing(null);
              reload();
            }}
          />
        )}
      </SidePanel>
    </>
  );
}
