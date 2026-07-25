import { createHash, randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import si from "systeminformation";
import {
  TokenUsageEventSchema,
  type Accuracy,
  type ProcessInfo,
  type ProjectInfo,
  type Provider,
  type TokenUsageEvent
} from "@ltm/shared-types";

const execFileAsync = promisify(execFile);
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[a-zA-Z0-9_-]{12,})\b/g,
  /\b(anthropic[_-]?(?:api[_-]?)?key)\s*[:=]\s*["']?([^\s"']+)/gi,
  /\bauthorization\s*[:=]\s*["']?Bearer\s+[^\s"',;]+/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)\s*[:=]\s*["']?([^\s"',;]+)/gi,
  /\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi
];

export function redactSecrets(value: string): string {
  let safe = value;
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, (match, label) => (label ? `${label}=[REDACTED]` : "[REDACTED]"));
  }
  safe = safe.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\[USER]");
  safe = safe.replace(/\/(?:Users|home)\/[^/\s]+/g, "/home/[USER]");
  return safe;
}

export function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function fingerprint(parts: Array<string | number | undefined>): string {
  return createHash("sha256").update(parts.map((part) => part ?? "").join("\u001f")).digest("hex");
}

export function normalizeUsage(input: {
  id?: string;
  provider: Provider;
  source?: TokenUsageEvent["source"];
  accuracy?: Accuracy;
    sessionId?: string;
    projectId?: string;
    projectPath?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  providerTotal?: number;
  timestamp?: string;
  estimationMethod?: string;
  isDemo?: boolean;
}): TokenUsageEvent {
  const inputTokens = Math.max(0, Math.trunc(input.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.trunc(input.outputTokens ?? 0));
  const cacheReadTokens = Math.max(0, Math.trunc(input.cacheReadTokens ?? 0));
  const cacheWriteTokens = Math.max(0, Math.trunc(input.cacheWriteTokens ?? 0));
  const reasoningTokens = Math.max(0, Math.trunc(input.reasoningTokens ?? 0));
  // Provider totals are authoritative. Without one, cache fields are separate
  // billable input components (as in Claude metadata); reasoning remains a
  // subset of output and must not be added again.
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = Math.max(0, Math.trunc(input.providerTotal ?? componentTotal));
  const timestamp = input.timestamp ?? new Date().toISOString();
  const eventFingerprint = fingerprint([
    input.provider,
    input.sessionId,
    input.projectId,
    input.model,
    input.source,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    timestamp
  ]);

  return TokenUsageEventSchema.parse({
    id: input.id ?? randomUUID(),
    fingerprint: eventFingerprint,
    provider: input.provider,
    source: input.source ?? "session",
    accuracy: input.accuracy ?? (input.providerTotal === undefined ? "derived" : "exact"),
    sessionId: input.sessionId,
    projectId: input.projectId,
    projectPath: input.projectPath,
    model: input.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    timestamp,
    estimationMethod: input.estimationMethod,
    isDemo: input.isDemo ?? false
  });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveProject(
  candidates: {
    processCwd?: string;
    workspaceRoot?: string;
    sessionPath?: string;
    parentCwd?: string;
  },
  gitRunner: (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }> =
    async (file, args) => {
      const result = await execFileAsync(file, args);
      return { stdout: result.stdout, stderr: result.stderr };
    }
): Promise<ProjectInfo> {
  const chosen =
    candidates.processCwd ??
    candidates.workspaceRoot ??
    candidates.sessionPath ??
    candidates.parentCwd ??
    process.cwd();
  const resolved = await realpath(chosen).catch(() => path.resolve(chosen));
  const gitRoot = await findGitRoot(resolved);
  const projectPath = gitRoot ?? resolved;
  let gitRemote: string | undefined;
  let gitBranch: string | undefined;
  if (gitRoot) {
    gitRemote = (await gitRunner("git", ["-C", gitRoot, "config", "--get", "remote.origin.url"]).catch(() => ({ stdout: "" }))).stdout.trim() || undefined;
    gitBranch = (await gitRunner("git", ["-C", gitRoot, "branch", "--show-current"]).catch(() => ({ stdout: "" }))).stdout.trim() || undefined;
  }
  const repositoryName = gitRemote?.split(/[/:]/).pop()?.replace(/\.git$/, "");
  return {
    id: fingerprint([projectPath]).slice(0, 16),
    name: repositoryName || path.basename(projectPath) || "Unknown project",
    path: projectPath,
    gitRemote,
    gitBranch,
    repositoryName
  };
}

function matchProvider(name: string, command = "", executablePath = ""): Provider | undefined {
  const haystack = `${name} ${command} ${executablePath}`.toLowerCase();
  if (/(^|[\\/\s])claude(?:\.exe)?(?:[\\/\s"']|$)/.test(haystack) || /@anthropic-ai[\\/]claude-code/.test(haystack)) return "claude";
  if (/(^|[\\/\s])codex(?:\.exe)?(?:[\\/\s"']|$)/.test(haystack) || /@openai[\\/]codex/.test(haystack)) return "codex";
  return undefined;
}

export function matchProviderProcess(process: { name: string; command?: string; path?: string }): Provider | undefined {
  return matchProvider(process.name, process.command, process.path);
}

export async function scanProcesses(): Promise<ProcessInfo[]> {
  const data = await si.processes();
  const matches: ProcessInfo[] = [];
  for (const process of data.list) {
    const provider = matchProviderProcess({ name: process.name, command: process.command, path: process.path });
    if (!provider) continue;
    matches.push({
      pid: process.pid,
      parentPid: process.parentPid,
      name: process.name,
      executablePath: process.path || undefined,
      // Never expose the raw command; keep only a redacted value for diagnostics.
      command: redactSecrets(process.command || ""),
      startedAt: process.started ? new Date(process.started).toISOString() : undefined,
      provider
    });
  }
  return matches;
}

export function privacyProject(project: ProjectInfo, enabled: boolean): ProjectInfo {
  if (!enabled) return project;
  return {
    ...project,
    path: `[private]/${path.basename(project.path)}`,
    gitRemote: project.gitRemote ? "[private remote]" : undefined
  };
}
