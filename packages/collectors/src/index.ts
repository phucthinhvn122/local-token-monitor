import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  CollectorSource,
  ProjectInfo,
  Provider,
  ProviderAdapter,
  ProviderUsageLimits,
  TokenUsageEvent
} from "@ltm/shared-types";
import { fingerprint, normalizeUsage, resolveProject, safeError } from "@ltm/core";
import type { MonitorDatabase } from "@ltm/database";

type JsonObject = Record<string, unknown>;

export interface JsonLinesParseState {
  offset: number;
  remainder: string;
  previousTotals: Map<string, number>;
  sessionId?: string;
  cwd?: string;
  model?: string;
}

export function createJsonLinesState(): JsonLinesParseState {
  return {
    offset: 0,
    remainder: "",
    previousTotals: new Map<string, number>()
  };
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function numberAt(source: JsonObject | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringAt(source: JsonObject | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length < 500) return value;
  }
  return undefined;
}

export function extractUsageEnvelope(record: unknown): {
  usage?: JsonObject;
  model?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  cumulative: boolean;
} {
  const root = object(record);
  if (!root) return { cumulative: false };
  const payload = object(root.payload);
  const info = object(payload?.info);
  const message = object(root.message);
  const result = object(root.result);
  const usage =
    object(info?.total_token_usage) ??
    object(info?.last_token_usage) ??
    object(payload?.usage) ??
    object(message?.usage) ??
    object(result?.usage) ??
    object(root.usage);
  const cumulative = Boolean(info?.total_token_usage === usage || root.cumulative === true);
  return {
    usage,
    model: stringAt(message, "model") ?? stringAt(payload, "model") ?? stringAt(root, "model"),
    sessionId: stringAt(root, "session_id", "sessionId") ?? stringAt(payload, "session_id", "sessionId"),
    timestamp: stringAt(root, "timestamp", "created_at", "createdAt") ?? stringAt(payload, "timestamp"),
    cwd: stringAt(root, "cwd", "workspace_root", "project_path") ?? stringAt(payload, "cwd", "workspace_root"),
    cumulative
  };
}

export function extractUsageLimits(record: unknown): ProviderUsageLimits | undefined {
  const root = object(record);
  const payload = object(root?.payload);
  if (payload?.type !== "token_count") return undefined;
  const rateLimits = object(payload.rate_limits);
  if (!rateLimits) return undefined;
  const parseWindow = (value: unknown) => {
    const window = object(value);
    const usedPercent = numberAt(window, "used_percent");
    if (usedPercent === undefined) return undefined;
    const resetsAtSeconds = numberAt(window, "resets_at");
    return {
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      windowMinutes: numberAt(window, "window_minutes"),
      resetsAt: resetsAtSeconds === undefined ? undefined : new Date(resetsAtSeconds * 1000).toISOString()
    };
  };
  const primary = parseWindow(rateLimits.primary);
  const secondary = parseWindow(rateLimits.secondary);
  if (!primary && !secondary) return undefined;
  const timestamp = stringAt(root, "timestamp", "created_at", "createdAt");
  return {
    primary,
    secondary,
    updatedAt: timestamp && !Number.isNaN(Date.parse(timestamp))
      ? new Date(timestamp).toISOString()
      : new Date().toISOString()
  };
}

export function parseStructuredUsage(
  record: unknown,
  provider: Provider,
  context: {
    sourcePath?: string;
    previousTotals?: Map<string, number>;
    sessionId?: string;
    cwd?: string;
    model?: string;
  } = {}
): TokenUsageEvent | undefined {
  const envelope = extractUsageEnvelope(record);
  if (!envelope.usage) return undefined;
  const usage = envelope.usage;
  let inputTokens = numberAt(usage, "input_tokens", "inputTokens", "prompt_tokens") ?? 0;
  let outputTokens = numberAt(usage, "output_tokens", "outputTokens", "completion_tokens") ?? 0;
  let cacheReadTokens = numberAt(
    usage,
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cache_read_tokens",
    "cacheReadTokens"
  ) ?? 0;
  let cacheWriteTokens = numberAt(
    usage,
    "cache_creation_input_tokens",
    "cache_write_input_tokens",
    "cache_write_tokens",
    "cacheWriteTokens"
  ) ?? 0;
  let reasoningTokens = numberAt(usage, "reasoning_output_tokens", "reasoning_tokens", "reasoningTokens") ?? 0;
  let total = numberAt(usage, "total_tokens", "totalTokens");
  const sessionId =
    envelope.sessionId ??
    context.sessionId ??
    (context.sourcePath ? path.basename(context.sourcePath).replace(/\.(jsonl?|log)$/i, "") : undefined);

  if (envelope.cumulative && context.previousTotals) {
    const key = sessionId ?? context.sourcePath ?? provider;
    const values = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, total ?? inputTokens + outputTokens];
    const delta = values.map((value, index) => Math.max(0, value - (context.previousTotals?.get(`${key}:${index}`) ?? 0)));
    values.forEach((value, index) => context.previousTotals?.set(`${key}:${index}`, value));
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens] = delta;
    total = delta[5];
    if (total === 0 && inputTokens === 0 && outputTokens === 0) return undefined;
  }

  if (
    (total ?? inputTokens + outputTokens) === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    reasoningTokens === 0
  ) return undefined;

  const timestamp = envelope.timestamp && !Number.isNaN(Date.parse(envelope.timestamp))
    ? new Date(envelope.timestamp).toISOString()
    : new Date().toISOString();
  const cwd = envelope.cwd ?? context.cwd;
  const projectId = cwd ? fingerprint([path.resolve(cwd)]).slice(0, 16) : undefined;
  return normalizeUsage({
    provider,
    source: "session",
    accuracy: total === undefined ? "derived" : "exact",
    sessionId,
    projectId,
    projectPath: cwd,
    model: envelope.model ?? context.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    providerTotal: total,
    timestamp
  });
}

export async function* parseJsonLines(
  source: CollectorSource,
  onError?: (message: string) => void,
  onUsageLimits?: (limits: ProviderUsageLimits) => void,
  state: JsonLinesParseState = createJsonLinesState()
): AsyncIterable<TokenUsageEvent> {
  const metadata = await stat(source.path).catch(() => undefined);
  if (!metadata) return;
  if (metadata.size < state.offset) {
    Object.assign(state, createJsonLinesState());
  }
  if (metadata.size === state.offset) return;

  const parseRecord = (line: string): TokenUsageEvent | undefined => {
    if (!line.trim() || line.length > 5_000_000) return undefined;
    try {
      const parsed = JSON.parse(line) as unknown;
      const usageLimits = extractUsageLimits(parsed);
      if (usageLimits) onUsageLimits?.(usageLimits);
      const root = object(parsed);
      const payload = object(root?.payload);
      if (root?.type === "session_meta") {
        state.sessionId = stringAt(payload, "session_id", "id") ?? state.sessionId;
        state.cwd = stringAt(payload, "cwd", "workspace_root") ?? state.cwd;
      } else if (root?.type === "turn_context") {
        state.cwd = stringAt(payload, "cwd", "workspace_root") ?? state.cwd;
        state.model = stringAt(payload, "model") ?? state.model;
      }
      return parseStructuredUsage(parsed, source.provider, {
        sourcePath: source.path,
        previousTotals: state.previousTotals,
        sessionId: state.sessionId,
        cwd: state.cwd,
        model: state.model
      });
    } catch (error) {
      onError?.(safeError(error));
      return undefined;
    }
  };

  const stream = createReadStream(source.path, { start: state.offset });
  const decoder = new StringDecoder("utf8");
  let buffer = state.remainder;
  state.remainder = "";
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    state.offset += bytes.length;
    buffer += decoder.write(bytes);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      const event = parseRecord(line);
      if (event) yield event;
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) {
    try {
      JSON.parse(buffer);
      const event = parseRecord(buffer.replace(/\r$/, ""));
      if (event) yield event;
      buffer = "";
    } catch {
      // Keep an incomplete trailing record until the provider finishes writing it.
    }
  }
  state.remainder = buffer.length <= 5_000_000 ? buffer : "";
}

export async function recentFiles(
  roots: string[],
  extensions = [".jsonl", ".json"],
  maxFiles = 250,
  maxAgeDays = 30
): Promise<string[]> {
  const results: Array<{ file: string; mtime: number }> = [];
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8 || results.length > maxFiles * 4) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".env") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, depth + 1);
      else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
        const metadata = await stat(fullPath).catch(() => undefined);
        if (metadata && metadata.mtimeMs >= cutoff) results.push({ file: fullPath, mtime: metadata.mtimeMs });
      }
    }
  }
  for (const root of roots) await walk(root, 0);
  return results.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((result) => result.file);
}

export class CollectorManager {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private sourceByPath = new Map<string, CollectorSource>();
  private projectByPath = new Map<string, Promise<ProjectInfo | undefined>>();
  private processing = new Set<string>();
  private pending = new Set<string>();
  private enabledAdapters: ProviderAdapter[] = [];
  private lastSourceDiscoveryAt = 0;
  private started = false;

  constructor(
    private readonly database: MonitorDatabase,
    private readonly adapters: ProviderAdapter[],
    private readonly onEvent: (event: { type: string; provider?: Provider; message: string; timestamp: string }) => void
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.sourceByPath.clear();
    const settings = this.database.getSettings();
    this.enabledAdapters = this.adapters.filter((adapter) =>
      adapter.id === "codex" ? settings.codexCollectorEnabled : settings.claudeCollectorEnabled
    );
    const allSources: CollectorSource[] = [];
    const primedSources: Array<{ adapter: ProviderAdapter; source: CollectorSource }> = [];
    for (const adapter of this.enabledAdapters) {
      const installation = await adapter.detectInstallation();
      this.database.upsertProvider(adapter.id, installation.installed, installation.version);
      const sessions = await adapter.detectRunningSessions().catch(() => []);
      for (const session of sessions) this.database.upsertSession(session);
      const sources = await adapter.discoverSources().catch(() => []);
      for (const source of sources) this.sourceByPath.set(source.path, source);
      if (!settings.demoMode) allSources.push(...sources);
      this.onEvent({
        type: "collector",
        provider: adapter.id,
        message: `${adapter.id === "codex" ? "Codex" : "Claude Code"} collector ready · ${sources.length} sources discovered`,
        timestamp: new Date().toISOString()
      });
      // Recent sources provide a useful initial snapshot without scanning years
      // of local history on the first launch.
      if (!settings.demoMode) {
        for (const source of sources.slice(0, 30)) {
          await this.ingest(adapter, source);
          primedSources.push({ adapter, source });
        }
      }
    }
    this.watcher = chokidar.watch(allSources.map((source) => source.path), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 }
    });
    this.watcher.on("change", (changedPath) => {
      const source = this.sourceByPath.get(changedPath);
      const adapter = this.adapters.find((item) => item.id === source?.provider);
      if (source && adapter) void this.ingest(adapter, source);
    });
    for (const item of primedSources) await this.ingest(item.adapter, item.source);
    this.lastSourceDiscoveryAt = Date.now();
    this.timer = setInterval(() => void this.refreshSessions(), Math.max(1500, settings.pollingIntervalMs));
    this.database.applyRetention();
  }

  private async ingest(adapter: ProviderAdapter, source: CollectorSource): Promise<void> {
    if (this.processing.has(source.path)) {
      this.pending.add(source.path);
      return;
    }
    this.processing.add(source.path);
    try {
      for await (const event of adapter.parseSource(source)) {
        if (event.projectPath) {
          let projectPromise = this.projectByPath.get(event.projectPath);
          if (!projectPromise) {
            projectPromise = resolveProject({ sessionPath: event.projectPath }).catch(() => undefined);
            this.projectByPath.set(event.projectPath, projectPromise);
          }
          const project = await projectPromise;
          if (project) {
            event.projectId = project.id;
            event.fingerprint = fingerprint([
              event.provider, event.sessionId, event.projectId, event.model, event.source,
              event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens,
              event.reasoningTokens, event.totalTokens, event.timestamp
            ]);
            this.database.upsertProject(project);
          }
        } else if (event.projectId) {
          this.database.upsertProject({ id: event.projectId, name: "Detected project", path: "[session metadata]" });
        }
        if (event.sessionId) {
          this.database.upsertSession({
            id: event.sessionId,
            provider: event.provider,
            projectId: event.projectId,
            model: event.model,
            startedAt: event.timestamp,
            lastActivityAt: event.timestamp,
            status: "completed"
          });
        }
        const inserted = this.database.insertUsage(event);
        if (!inserted && "markDuplicate" in adapter && typeof adapter.markDuplicate === "function") {
          adapter.markDuplicate();
        }
        if (inserted) {
          this.onEvent({
            type: "usage",
            provider: event.provider,
            message: `${event.totalTokens.toLocaleString()} tokens recorded`,
            timestamp: event.timestamp
          });
        }
      }
    } catch (error) {
      this.onEvent({ type: "error", provider: adapter.id, message: safeError(error), timestamp: new Date().toISOString() });
    } finally {
      this.processing.delete(source.path);
      if (this.pending.delete(source.path)) void this.ingest(adapter, source);
    }
  }

  private async refreshSessions(): Promise<void> {
    for (const adapter of this.enabledAdapters) {
      const sessions = await adapter.detectRunningSessions().catch(() => []);
      for (const session of sessions) this.database.upsertSession(session);
    }
    if (Date.now() - this.lastSourceDiscoveryAt < 10_000) return;
    this.lastSourceDiscoveryAt = Date.now();
    if (this.database.getSettings().demoMode) return;
    for (const adapter of this.enabledAdapters) {
      const sources = await adapter.discoverSources().catch(() => []);
      for (const source of sources) {
        if (this.sourceByPath.has(source.path)) continue;
        this.sourceByPath.set(source.path, source);
        await this.watcher?.add(source.path);
        void this.ingest(adapter, source);
      }
    }
  }

  async diagnostics(): Promise<unknown[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.getDiagnostics()));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.watcher?.close();
    this.timer = undefined;
    this.watcher = undefined;
    this.sourceByPath.clear();
    this.pending.clear();
    this.enabledAdapters = [];
    this.started = false;
  }
}
