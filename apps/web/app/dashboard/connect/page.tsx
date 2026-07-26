"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Download, ShieldCheck, Terminal } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { PageHeader } from "@/components/shell";
import { Badge, Button, Card, CardHeader, CopyButton, ErrorState, Skeleton, useToast } from "@/components/ui";
import { cn } from "@/lib/utils";

type Mode = "provider" | "openai";

interface SetupResponse {
  mode: Mode;
  keyAvailable: boolean;
  apiKeyId: string;
  maskedKey: string;
  gatewayBaseUrl: string;
  model: string;
  envKey: string;
  wireApi: "chat" | "responses";
  bundle: {
    codexHome: string;
    configToml: string;
    authJson: string | null;
    envExportBash: string | null;
    envExportPowershell: string | null;
    installBash: string;
    installPowershell: string;
  };
  steps: Array<{ title: string; body: string; language: string }>;
}

function CodeBlock({
  code,
  language,
  label
}: {
  code: string;
  language?: string;
  label?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <span className="font-mono text-[11px] text-[var(--text-faint)]">{label ?? language}</span>
        <CopyButton value={code} />
      </div>
      {/* Long lines scroll inside the block; the page itself never scrolls sideways. */}
      <pre className="overflow-x-auto px-3 py-3 font-mono text-[12px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** useSearchParams needs a Suspense boundary under the App Router. */
export default function ConnectCodexPage() {
  return (
    <React.Suspense fallback={<Skeleton className="h-64" />}>
      <ConnectCodexContent />
    </React.Suspense>
  );
}

function ConnectCodexContent() {
  const params = useSearchParams();
  const apiKeyId = params.get("apiKeyId") ?? undefined;
  const [mode, setMode] = React.useState<Mode>("provider");
  const [platform, setPlatform] = React.useState<"unix" | "windows">("unix");
  const toast = useToast();

  React.useEffect(() => {
    // Default the platform tab to whatever the visitor is actually on.
    if (typeof navigator !== "undefined" && /win/i.test(navigator.platform)) setPlatform("windows");
  }, []);

  const query = new URLSearchParams({ mode, ...(apiKeyId ? { apiKeyId } : {}) }).toString();
  const { data, error, loading, reload } = useApi<SetupResponse>(`/api/me/codex-setup?${query}`);

  if (error) return <ErrorState message={error} onRetry={reload} />;

  const download = () => {
    if (!data?.keyAvailable) {
      toast("This key can no longer produce a config file. Ask an administrator to rotate it.", "error");
      return;
    }
    window.location.href = `/api/me/codex-setup/download?${query}`;
  };

  return (
    <>
      <PageHeader
        title="Connect Codex CLI"
        description="Point Codex at this gateway. Two clicks: pick a method, run the installer."
      />

      {data && !data.keyAvailable && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
          <div className="text-[13px]">
            <p className="font-medium text-[var(--color-warning)]">Your full key is no longer available</p>
            <p className="mt-0.5 text-[var(--text-muted)]">
              The configuration below shows the exact shape of the files, but the key is replaced by a
              placeholder. Ask an administrator to rotate your key to get a working config.
            </p>
          </div>
        </div>
      )}

      {/* Step 1 — choose the method. */}
      <Card className="mb-4">
        <CardHeader
          title="1 · Choose how Codex should authenticate"
          description="Both point Codex at this gateway. They differ only in where the key lives."
        />
        <div className="grid gap-3 px-5 pb-5 pt-4 sm:grid-cols-2">
          {(
            [
              {
                id: "provider" as const,
                title: "Dedicated provider",
                badge: "Recommended",
                body: "Adds a [model_providers.*] block to config.toml and keeps the key in an environment variable. Nothing secret is written into the TOML file."
              },
              {
                id: "openai" as const,
                title: "Override the built-in provider",
                badge: "Fully hands-off",
                body: "Sets openai_base_url in config.toml and writes the key to auth.json, the same shape codex login --with-api-key produces. No environment variable to manage."
              }
            ]
          ).map((option) => (
            <button
              key={option.id}
              onClick={() => setMode(option.id)}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                mode === option.id
                  ? "border-[var(--color-accent-500)] bg-[var(--color-accent-500)]/8"
                  : "border-[var(--border)] hover:border-[var(--border-strong)]"
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{option.title}</span>
                <Badge tone={option.id === "provider" ? "accent" : "neutral"}>{option.badge}</Badge>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-muted)]">{option.body}</p>
            </button>
          ))}
        </div>
      </Card>

      {/* Step 2 — one action gets it done. */}
      <Card className="mb-4">
        <CardHeader
          title="2 · Install"
          description="The script backs up any existing ~/.codex files with a timestamped .bak suffix before writing."
          action={
            <div className="flex gap-1 rounded-lg border border-[var(--border)] p-0.5">
              {(["unix", "windows"] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setPlatform(option)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                    platform === option
                      ? "bg-[var(--bg-subtle)] text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]"
                  )}
                >
                  {option === "unix" ? "macOS / Linux" : "Windows"}
                </button>
              ))}
            </div>
          }
        />

        <div className="space-y-3 px-5 pb-5 pt-4">
          {loading || !data ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={download} disabled={!data.keyAvailable}>
                  <Download className="h-4 w-4" />
                  Download setup files (.zip)
                </Button>
                <CopyButton
                  size="md"
                  label={platform === "unix" ? "Copy install script" : "Copy PowerShell script"}
                  value={platform === "unix" ? data.bundle.installBash : data.bundle.installPowershell}
                />
              </div>

              <p className="text-[12px] text-[var(--text-muted)]">
                {platform === "unix" ? (
                  <>
                    Paste the copied script into a terminal, or run{" "}
                    <code className="rounded bg-[var(--bg-subtle)] px-1 py-0.5 font-mono">bash install.sh</code>{" "}
                    from the downloaded zip.
                  </>
                ) : (
                  <>
                    Run{" "}
                    <code className="rounded bg-[var(--bg-subtle)] px-1 py-0.5 font-mono">
                      powershell -ExecutionPolicy Bypass -File install.ps1
                    </code>{" "}
                    from the downloaded zip.
                  </>
                )}
              </p>

              <CodeBlock
                code={platform === "unix" ? data.bundle.installBash : data.bundle.installPowershell}
                label={platform === "unix" ? "install.sh" : "install.ps1"}
              />
            </>
          )}
        </div>
      </Card>

      {/* Step 3 — the files themselves, for anyone who wants to do it by hand. */}
      <Card className="mb-4">
        <CardHeader
          title="3 · Or write the files yourself"
          description={`Everything below belongs in ${data?.bundle.codexHome ?? "~/.codex"} (or $CODEX_HOME).`}
        />
        <div className="space-y-4 px-5 pb-5 pt-4">
          {loading || !data ? (
            <Skeleton className="h-48" />
          ) : (
            data.steps.map((step, index) => (
              <div key={step.title}>
                <p className="mb-2 flex items-center gap-2 text-[13px] font-medium">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-subtle)] text-[11px] text-[var(--text-muted)]">
                    {index + 1}
                  </span>
                  {step.title}
                </p>
                <CodeBlock code={step.body} language={step.language} />
              </div>
            ))
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Connection details" />
        <div className="grid gap-x-6 gap-y-3 px-5 pb-5 pt-4 text-[13px] sm:grid-cols-2">
          {loading || !data ? (
            <Skeleton className="h-16 sm:col-span-2" />
          ) : (
            <>
              <div>
                <p className="text-[var(--text-faint)]">Gateway base URL</p>
                <code className="font-mono text-[12px]">{data.gatewayBaseUrl.replace(/\/v1$/, "")}/v1</code>
              </div>
              <div>
                <p className="text-[var(--text-faint)]">Default model</p>
                <code className="font-mono text-[12px]">{data.model}</code>
              </div>
              <div>
                <p className="text-[var(--text-faint)]">Wire API</p>
                <code className="font-mono text-[12px]">{data.wireApi}</code>
              </div>
              <div>
                <p className="text-[var(--text-faint)]">Your key</p>
                <code className="font-mono text-[12px]">{data.maskedKey}</code>
              </div>
              <div>
                <p className="text-[var(--text-faint)]">
                  {mode === "provider" ? "Environment variable" : "Credential file"}
                </p>
                <code className="font-mono text-[12px]">
                  {mode === "provider" ? data.envKey : "~/.codex/auth.json"}
                </code>
              </div>
            </>
          )}
        </div>
        <div className="mx-5 mb-5 flex items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)]/50 px-3 py-2.5 text-[12px] text-[var(--text-muted)]">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-safe)]" />
          <p>
            These files contain your personal gateway key — treat them like a password. Codex only honours
            provider settings in the user-level config, so keep them in{" "}
            <code className="font-mono">~/.codex/</code> rather than a project directory. Field names have
            changed between Codex releases; if <code className="font-mono">codex</code> reports an unknown
            key, check your CLI version against the block above.
          </p>
        </div>
      </Card>

      <p className="mt-6 flex items-center gap-1.5 text-[12px] text-[var(--text-faint)]">
        <Terminal className="h-3.5 w-3.5" />
        Verify with <code className="font-mono">codex --version</code>, then start a session — usage will
        appear on your dashboard within seconds.
      </p>
    </>
  );
}
