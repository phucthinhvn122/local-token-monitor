import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  DetectedSession,
  ModelPricing,
  ProviderQuotaSnapshot,
  ProjectInfo,
  QuotaStatus,
  ThirdPartyProviderConfig,
  TokenUsageEvent,
  UsageFilters
} from "@ltm/shared-types";
import {
  ProviderQuotaSnapshotSchema,
  ThirdPartyProviderConfigSchema
} from "@ltm/shared-types";
import { calculateCost } from "@ltm/token-estimator";
import { fingerprint, privacyProject } from "@ltm/core";

// Constructing the built-in specifier prevents older bundlers from rewriting
// `node:sqlite` to the unsupported bare package name `sqlite`.
const sqliteBuiltin = ["node", "sqlite"].join(":");
const { DatabaseSync } = await import(sqliteBuiltin) as typeof import("node:sqlite");

const defaults: AppSettings = {
  port: 3456,
  databasePath: "",
  retentionDays: 90,
  pollingIntervalMs: 3000,
  codexCollectorEnabled: true,
  claudeCollectorEnabled: true,
  tokenEstimationEnabled: false,
  costEstimationEnabled: true,
  privacyMode: false,
  demoMode: process.env.LTM_DEMO_MODE === "true",
  allowNetwork: false,
  providerNetworkEnabled: false,
  customProviderPaths: [],
  customLogPaths: []
};

type Row = Record<string, unknown>;

export class MonitorDatabase {
  readonly db: import("node:sqlite").DatabaseSync;
  readonly path: string;

  constructor(databasePath?: string) {
    this.path =
      databasePath ||
      process.env.LTM_DATABASE_PATH ||
      path.join(os.homedir(), ".local-token-monitor", "token-monitor.sqlite");
    mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.migrate();
    this.seedPricing();
    this.seedDemo();
  }

  migrate(): void {
    const migrationsPath = path.join(import.meta.dirname, "migrations");
    for (const file of readdirSync(migrationsPath).filter((name) => name.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(path.join(migrationsPath, file), "utf8"));
    }
  }

  private seedPricing(): void {
    const count = (this.db.prepare("SELECT COUNT(*) AS count FROM model_pricing").get() as Row).count as number;
    if (count) return;
    const pricing = JSON.parse(readFileSync(path.join(import.meta.dirname, "pricing.json"), "utf8")) as ModelPricing[];
    const insert = this.db.prepare(
      `INSERT INTO model_pricing
      (provider, model_pattern, input_per_million, output_per_million, cache_read_per_million, cache_write_per_million, effective_from, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of pricing) {
      insert.run(
        item.provider,
        item.modelPattern,
        item.inputPerMillion,
        item.outputPerMillion,
        item.cacheReadPerMillion ?? null,
        item.cacheWritePerMillion ?? null,
        item.effectiveFrom,
        item.sourceUrl ?? null
      );
    }
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value_json FROM settings").all() as Row[];
    const saved = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(String(row.value_json))]));
    return { ...defaults, ...saved, databasePath: this.path };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const insert = this.db.prepare(
      `INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    );
    const allowed = new Set(Object.keys(defaults));
    for (const [key, value] of Object.entries(patch)) {
      if (allowed.has(key) && key !== "databasePath") insert.run(key, JSON.stringify(value), new Date().toISOString());
    }
    return this.getSettings();
  }

  getPricing(): ModelPricing[] {
    return (this.db.prepare("SELECT * FROM model_pricing ORDER BY effective_from DESC").all() as Row[]).map((row) => ({
      provider: row.provider as ModelPricing["provider"],
      modelPattern: String(row.model_pattern),
      inputPerMillion: Number(row.input_per_million),
      outputPerMillion: Number(row.output_per_million),
      cacheReadPerMillion: row.cache_read_per_million == null ? undefined : Number(row.cache_read_per_million),
      cacheWritePerMillion: row.cache_write_per_million == null ? undefined : Number(row.cache_write_per_million),
      effectiveFrom: String(row.effective_from),
      sourceUrl: row.source_url ? String(row.source_url) : undefined
    }));
  }

  replacePricing(pricing: ModelPricing[]): void {
    this.db.exec("BEGIN; DELETE FROM model_pricing;");
    try {
      const insert = this.db.prepare(
        `INSERT INTO model_pricing
        (provider, model_pattern, input_per_million, output_per_million, cache_read_per_million, cache_write_per_million, effective_from, source_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of pricing) {
        insert.run(item.provider, item.modelPattern, item.inputPerMillion, item.outputPerMillion, item.cacheReadPerMillion ?? null, item.cacheWritePerMillion ?? null, item.effectiveFrom, item.sourceUrl ?? null);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureThirdPartyProviderConfigs(configs: ThirdPartyProviderConfig[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO third_party_provider_configs
       (id,adapter_id,display_name,base_url,quota_endpoint,api_key_env,protocol,enabled,refresh_interval_minutes,endpoint_verified,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const now = new Date().toISOString();
    for (const input of configs) {
      const config = ThirdPartyProviderConfigSchema.parse(input);
      insert.run(
        config.id,
        config.adapterId,
        config.displayName,
        config.baseUrl ?? null,
        config.quotaEndpoint ?? null,
        config.apiKeyEnv ?? null,
        config.protocol,
        config.enabled ? 1 : 0,
        config.refreshIntervalMinutes,
        config.endpointVerified ? 1 : 0,
        now
      );
    }
  }

  thirdPartyProviderConfigs(): ThirdPartyProviderConfig[] {
    return (this.db.prepare(
      "SELECT * FROM third_party_provider_configs ORDER BY CASE id WHEN 'freemodel' THEN 1 WHEN 'nttcodex' THEN 2 ELSE 3 END, id"
    ).all() as Row[]).map((row) => ThirdPartyProviderConfigSchema.parse({
      id: row.id,
      adapterId: row.adapter_id,
      displayName: row.display_name,
      baseUrl: row.base_url ?? undefined,
      quotaEndpoint: row.quota_endpoint ?? undefined,
      apiKeyEnv: row.api_key_env ?? undefined,
      protocol: row.protocol,
      enabled: Boolean(row.enabled),
      refreshIntervalMinutes: Number(row.refresh_interval_minutes),
      endpointVerified: Boolean(row.endpoint_verified)
    }));
  }

  updateThirdPartyProviderConfig(id: ThirdPartyProviderConfig["id"], patch: Partial<ThirdPartyProviderConfig>): ThirdPartyProviderConfig {
    const existing = this.thirdPartyProviderConfigs().find((item) => item.id === id);
    if (!existing) throw new Error("Third-party provider config not found.");
    const config = ThirdPartyProviderConfigSchema.parse({ ...existing, ...patch, id, adapterId: existing.adapterId });
    this.db.prepare(
      `UPDATE third_party_provider_configs
       SET display_name=?,base_url=?,quota_endpoint=?,api_key_env=?,protocol=?,enabled=?,refresh_interval_minutes=?,endpoint_verified=?,updated_at=?
       WHERE id=?`
    ).run(
      config.displayName,
      config.baseUrl ?? null,
      config.quotaEndpoint ?? null,
      config.apiKeyEnv ?? null,
      config.protocol,
      config.enabled ? 1 : 0,
      config.refreshIntervalMinutes,
      config.endpointVerified ? 1 : 0,
      new Date().toISOString(),
      id
    );
    return config;
  }

  saveProviderQuotaSnapshot(input: ProviderQuotaSnapshot): ProviderQuotaSnapshot {
    const snapshot = ProviderQuotaSnapshotSchema.parse(input);
    this.db.prepare(
      `INSERT INTO provider_quota_snapshots(provider_id,snapshot_json,observed_at)
       VALUES (?,?,?)
       ON CONFLICT(provider_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,observed_at=excluded.observed_at`
    ).run(snapshot.providerId, JSON.stringify(snapshot), snapshot.fetchedAt);
    return snapshot;
  }

  providerQuotaSnapshot(id: ThirdPartyProviderConfig["id"]): ProviderQuotaSnapshot | undefined {
    const row = this.db.prepare(
      "SELECT snapshot_json FROM provider_quota_snapshots WHERE provider_id=?"
    ).get(id) as Row | undefined;
    if (!row) return undefined;
    try {
      return ProviderQuotaSnapshotSchema.parse(JSON.parse(String(row.snapshot_json)));
    } catch {
      return undefined;
    }
  }

  providerQuotaSnapshots(): ProviderQuotaSnapshot[] {
    const rows = this.db.prepare("SELECT snapshot_json FROM provider_quota_snapshots ORDER BY observed_at DESC").all() as Row[];
    return rows.flatMap((row) => {
      try {
        return [ProviderQuotaSnapshotSchema.parse(JSON.parse(String(row.snapshot_json)))];
      } catch {
        return [];
      }
    });
  }

  deleteProviderQuotaSnapshot(id: ThirdPartyProviderConfig["id"]): void {
    this.db.prepare("DELETE FROM provider_quota_snapshots WHERE provider_id=?").run(id);
  }

  upsertProvider(id: "codex" | "claude", installed: boolean, version?: string): void {
    this.db.prepare(
      `INSERT INTO providers(id, name, installed, version, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET installed=excluded.installed, version=excluded.version, last_seen_at=excluded.last_seen_at`
    ).run(id, id === "codex" ? "OpenAI Codex" : "Claude Code", installed ? 1 : 0, version ?? null, new Date().toISOString());
  }

  upsertProject(project: ProjectInfo): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO projects(id,name,display_name,path,git_remote,git_branch,repository_name,hidden,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,git_remote=excluded.git_remote,
       git_branch=excluded.git_branch,repository_name=excluded.repository_name,updated_at=excluded.updated_at`
    ).run(project.id, project.name, project.displayName ?? null, project.path, project.gitRemote ?? null, project.gitBranch ?? null, project.repositoryName ?? null, project.hidden ? 1 : 0, project.isDemo ? 1 : 0, now, now);
  }

  upsertSession(session: DetectedSession): void {
    this.db.prepare(
      `INSERT INTO sessions(id,provider,project_id,model,process_id,started_at,last_activity_at,status,accuracy,is_demo)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,model=excluded.model,process_id=excluded.process_id,
       last_activity_at=excluded.last_activity_at,status=excluded.status`
    ).run(session.id, session.provider, session.projectId ?? null, session.model ?? null, session.processId ?? null, session.startedAt, session.lastActivityAt, session.status, "unavailable", session.isDemo ? 1 : 0);
  }

  insertUsage(event: TokenUsageEvent): boolean {
    const pricing = this.getSettings().costEstimationEnabled ? this.getPricing() : [];
    const estimatedCost = event.estimatedCost ?? calculateCost(event, pricing);
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO token_usage_events
      (id,fingerprint,provider,source,accuracy,session_id,project_id,model,input_tokens,output_tokens,cache_read_tokens,
       cache_write_tokens,reasoning_tokens,total_tokens,estimated_cost,currency,estimation_method,timestamp,is_demo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      event.id, event.fingerprint, event.provider, event.source, event.accuracy, event.sessionId ?? null,
      event.projectId ?? null, event.model ?? null, event.inputTokens, event.outputTokens, event.cacheReadTokens ?? 0,
      event.cacheWriteTokens ?? 0, event.reasoningTokens ?? 0, event.totalTokens, estimatedCost ?? null,
      estimatedCost == null ? null : "USD", event.estimationMethod ?? null, event.timestamp, event.isDemo ? 1 : 0
    );
    return result.changes > 0;
  }

  private filterSql(filters: UsageFilters = {}, alias = "e"): { sql: string; params: Array<string | number | null> } {
    const settings = this.getSettings();
    const clauses = [`${alias}.is_demo = ?`];
    const params: Array<string | number | null> = [settings.demoMode ? 1 : 0];
    for (const [column, value] of [
      ["timestamp >=", filters.from],
      ["timestamp <=", filters.to],
      ["provider =", filters.provider],
      ["project_id =", filters.projectId],
      ["session_id =", filters.sessionId],
      ["model =", filters.model],
      ["accuracy =", filters.accuracy]
    ] as Array<[string, string | undefined]>) {
      if (value) {
        clauses.push(`${alias}.${column} ?`);
        params.push(value);
      }
    }
    return { sql: clauses.join(" AND "), params };
  }

  usageEvents(filters: UsageFilters = {}): Row[] {
    const where = this.filterSql(filters);
    return this.db.prepare(`SELECT * FROM token_usage_events e WHERE ${where.sql} ORDER BY timestamp ASC`).all(...where.params) as Row[];
  }

  summary(filters: UsageFilters = {}): Record<string, unknown> {
    const events = this.usageEvents(filters);
    const sum = (key: string) => events.reduce((total, event) => total + Number(event[key] ?? 0), 0);
    const exact = events.filter((event) => event.accuracy === "exact" || event.accuracy === "derived").length;
    return {
      totalTokens: sum("total_tokens"),
      inputTokens: sum("input_tokens"),
      outputTokens: sum("output_tokens"),
      cacheTokens: sum("cache_read_tokens") + sum("cache_write_tokens"),
      reasoningTokens: sum("reasoning_tokens"),
      estimatedCost: Math.round(sum("estimated_cost") * 1e4) / 1e4,
      eventCount: events.length,
      exactRate: events.length ? Math.round((exact / events.length) * 100) : 0
    };
  }

  timeline(filters: UsageFilters = {}): Row[] {
    const events = this.usageEvents(filters);
    const interval = filters.interval ?? "day";
    const bucketMs =
      interval === "5m" ? 5 * 60_000 :
      interval === "15m" ? 15 * 60_000 :
      interval === "hour" ? 3_600_000 :
      interval === "6h" ? 21_600_000 : 86_400_000;
    const buckets = new Map<number, Row>();
    for (const event of events) {
      const bucket = Math.floor(new Date(String(event.timestamp)).getTime() / bucketMs) * bucketMs;
      const current = buckets.get(bucket) ?? { timestamp: new Date(bucket).toISOString(), input: 0, output: 0, cache: 0, reasoning: 0, total: 0 };
      current.input = Number(current.input) + Number(event.input_tokens);
      current.output = Number(current.output) + Number(event.output_tokens);
      current.cache = Number(current.cache) + Number(event.cache_read_tokens) + Number(event.cache_write_tokens);
      current.reasoning = Number(current.reasoning) + Number(event.reasoning_tokens);
      current.total = Number(current.total) + Number(event.total_tokens);
      buckets.set(bucket, current);
    }
    return [...buckets.values()];
  }

  projects(): Row[] {
    const demo = this.getSettings().demoMode ? 1 : 0;
    const privacy = this.getSettings().privacyMode;
    const rows = this.db.prepare(
      `WITH session_totals AS (
         SELECT project_id, is_demo, GROUP_CONCAT(DISTINCT provider) providers,
                GROUP_CONCAT(DISTINCT model) models,
                COUNT(DISTINCT CASE WHEN status='running' THEN id END) active_sessions
         FROM sessions GROUP BY project_id, is_demo
       ), event_totals AS (
         SELECT project_id, is_demo, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
                SUM(cache_read_tokens+cache_write_tokens) cache_tokens, SUM(total_tokens) total_tokens,
                SUM(estimated_cost) estimated_cost, MAX(timestamp) last_activity,
                ROUND(100.0*SUM(CASE WHEN accuracy IN ('exact','derived') THEN 1 ELSE 0 END)/MAX(COUNT(id),1)) exact_rate
         FROM token_usage_events GROUP BY project_id, is_demo
       )
       SELECT p.*, COALESCE(a.display_name,p.display_name,p.name) AS effective_name,
              s.providers, s.models, COALESCE(s.active_sessions,0) active_sessions,
              COALESCE(e.input_tokens,0) input_tokens, COALESCE(e.output_tokens,0) output_tokens,
              COALESCE(e.cache_tokens,0) cache_tokens, COALESCE(e.total_tokens,0) total_tokens,
              COALESCE(e.estimated_cost,0) estimated_cost, e.last_activity, COALESCE(e.exact_rate,0) exact_rate
       FROM projects p LEFT JOIN aliases a ON a.project_id=p.id
       LEFT JOIN session_totals s ON s.project_id=p.id AND s.is_demo=p.is_demo
       LEFT JOIN event_totals e ON e.project_id=p.id AND e.is_demo=p.is_demo
       WHERE p.is_demo=? AND p.hidden=0 ORDER BY last_activity DESC`
    ).all(demo) as Row[];
    return rows.map((row) => {
      const project = privacyProject({
        id: String(row.id), name: String(row.effective_name), path: String(row.path),
        gitRemote: row.git_remote ? String(row.git_remote) : undefined,
        gitBranch: row.git_branch ? String(row.git_branch) : undefined
      }, privacy);
      return { ...row, name: project.name, path: project.path, git_remote: project.gitRemote };
    });
  }

  project(id: string): Row | undefined {
    const project = this.projects().find((row) => row.id === id);
    if (!project) return undefined;
    return {
      ...project,
      sessions: this.sessions({ projectId: id }),
      timeline: this.timeline({ projectId: id, interval: "day" }),
      breakdown: this.breakdown({ projectId: id })
    };
  }

  sessions(filters: UsageFilters = {}): Row[] {
    const demo = this.getSettings().demoMode ? 1 : 0;
    const clauses = ["s.is_demo=?"];
    const params: Array<string | number | null> = [demo];
    if (filters.provider) { clauses.push("s.provider=?"); params.push(filters.provider); }
    if (filters.projectId) { clauses.push("s.project_id=?"); params.push(filters.projectId); }
    if (filters.model) { clauses.push("s.model=?"); params.push(filters.model); }
    if (filters.sessionId) { clauses.push("s.id=?"); params.push(filters.sessionId); }
    return this.db.prepare(
      `SELECT s.*, COALESCE(a.display_name,p.display_name,p.name,'Unresolved') project_name,
       COALESCE(SUM(e.input_tokens),0) input_tokens, COALESCE(SUM(e.output_tokens),0) output_tokens,
       COALESCE(SUM(e.total_tokens),0) total_tokens,
       CASE WHEN SUM(CASE WHEN e.accuracy='estimated' THEN 1 ELSE 0 END)>0 THEN 'estimated'
            WHEN COUNT(e.id)>0 THEN 'exact' ELSE 'unavailable' END AS usage_accuracy
       FROM sessions s LEFT JOIN projects p ON p.id=s.project_id LEFT JOIN aliases a ON a.project_id=p.id
       LEFT JOIN token_usage_events e ON e.session_id=s.id
       WHERE ${clauses.join(" AND ")} GROUP BY s.id ORDER BY s.last_activity_at DESC`
    ).all(...params) as Row[];
  }

  breakdown(filters: UsageFilters = {}): Row[] {
    const where = this.filterSql(filters);
    return this.db.prepare(
      `SELECT provider, SUM(total_tokens) total_tokens, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
       SUM(estimated_cost) estimated_cost, COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT project_id) projects,
       ROUND(100.0*SUM(CASE WHEN accuracy IN ('exact','derived') THEN 1 ELSE 0 END)/MAX(COUNT(*),1)) exact_rate
       FROM token_usage_events e WHERE ${where.sql} GROUP BY provider`
    ).all(...where.params) as Row[];
  }

  activity(limit = 12): Row[] {
    const demo = this.getSettings().demoMode ? 1 : 0;
    return this.db.prepare(
      `SELECT e.timestamp, e.provider, e.total_tokens, e.input_tokens, e.accuracy,
       COALESCE(a.display_name,p.display_name,p.name,'Unresolved') project_name
       FROM token_usage_events e LEFT JOIN projects p ON p.id=e.project_id LEFT JOIN aliases a ON a.project_id=p.id
       WHERE e.is_demo=? ORDER BY e.timestamp DESC LIMIT ?`
    ).all(demo, limit) as Row[];
  }

  renameProject(id: string, displayName: string): void {
    this.db.prepare(
      `INSERT INTO aliases(project_id,display_name,updated_at) VALUES (?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at`
    ).run(id, displayName.slice(0, 80), new Date().toISOString());
  }

  hideProject(id: string): void {
    this.db.prepare("UPDATE projects SET hidden=1 WHERE id=?").run(id);
    this.db.prepare("INSERT OR IGNORE INTO ignored_projects(project_id,created_at) VALUES (?,?)").run(id, new Date().toISOString());
  }

  applyRetention(): number {
    const days = this.getSettings().retentionDays;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM token_usage_events WHERE is_demo=0 AND timestamp < ?").run(cutoff).changes);
  }

  reset(realOnly = false): void {
    const clause = realOnly ? " WHERE is_demo=0" : "";
    this.db.exec(`DELETE FROM token_usage_events${clause}; DELETE FROM sessions${clause}; DELETE FROM projects${clause};`);
    if (!realOnly) this.db.exec("DELETE FROM provider_quota_snapshots;");
    if (!realOnly) this.seedDemo();
  }

  exportData(format: "json" | "csv"): string {
    const events = this.usageEvents();
    if (format === "json") return JSON.stringify({ exportedAt: new Date().toISOString(), events }, null, 2);
    const headers = ["timestamp","provider","project_id","session_id","model","accuracy","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","reasoning_tokens","total_tokens","estimated_cost"];
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    return [headers.join(","), ...events.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
  }

  private seedDemo(): void {
    const count = Number((this.db.prepare("SELECT COUNT(*) count FROM projects WHERE is_demo=1").get() as Row).count);
    if (count) return;
    const projectDefs = [
      { id: "demo-aurora", name: "Aurora Dashboard", path: "/demo/aurora-dashboard", git: "github.com/example/aurora-dashboard", branch: "main" },
      { id: "demo-atlas", name: "Atlas API", path: "/demo/atlas-api", git: "github.com/example/atlas-api", branch: "feat/streaming" },
      { id: "demo-compass", name: "Compass Mobile", path: "/demo/compass-mobile", git: "github.com/example/compass-mobile", branch: "develop" }
    ];
    for (const project of projectDefs) {
      this.upsertProject({ id: project.id, name: project.name, path: project.path, gitRemote: project.git, gitBranch: project.branch, repositoryName: project.name, isDemo: true });
    }
    const models = {
      codex: ["gpt-5-codex", "gpt-5.1-codex-mini"],
      claude: ["claude-sonnet-4-5", "claude-opus-4-1"]
    };
    for (let index = 0; index < 9; index++) {
      const provider = index % 2 === 0 ? "codex" : "claude";
      const project = projectDefs[index % projectDefs.length];
      const id = `demo-session-${index + 1}`;
      const start = new Date(Date.now() - index * 2.4 * 86_400_000);
      this.upsertSession({
        id,
        provider,
        projectId: project.id,
        model: models[provider][index % 2],
        startedAt: start.toISOString(),
        lastActivityAt: new Date(start.getTime() + 48 * 60_000).toISOString(),
        status: index < 2 ? "running" : "completed",
        isDemo: true
      });
    }
    for (let day = 29; day >= 0; day--) {
      for (let providerIndex = 0; providerIndex < 2; providerIndex++) {
        const provider = providerIndex === 0 ? "codex" : "claude";
        const project = projectDefs[(day + providerIndex) % projectDefs.length];
        const sessionIndex = (day + providerIndex) % 9;
        const input = 1800 + ((day * 743 + providerIndex * 911) % 7200);
        const output = 720 + ((day * 389 + providerIndex * 317) % 3300);
        const cacheRead = day % 3 === 0 ? Math.round(input * 0.28) : 0;
        const cacheWrite = provider === "claude" && day % 4 === 0 ? Math.round(input * 0.08) : 0;
        const reasoning = provider === "codex" && day % 2 === 0 ? Math.round(output * 0.35) : 0;
        const timestamp = new Date(Date.now() - day * 86_400_000 + providerIndex * 3_600_000).toISOString();
        const accuracy = day % 7 === 0 ? "estimated" : day % 5 === 0 ? "derived" : "exact";
        this.insertUsage({
          id: randomUUID(),
          fingerprint: fingerprint(["demo", day, provider]),
          provider,
          source: accuracy === "estimated" ? "estimated" : "session",
          accuracy,
          sessionId: `demo-session-${sessionIndex + 1}`,
          projectId: project.id,
          model: models[provider][day % 2],
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: reasoning,
          totalTokens: input + output,
          estimationMethod: accuracy === "estimated" ? "fixture: utf8-bytes/4" : undefined,
          timestamp,
          isDemo: true
        });
      }
    }
  }

  saveQuotaStatus(status: QuotaStatus): void {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO nxtcodex_quota_history
       (id, provider, key_id, status, total, used, remaining, unit, reset_at, seconds_until_reset, checked_at, source, raw_headers_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      status.provider,
      status.keyId ?? null,
      status.status,
      status.total ?? null,
      status.used ?? null,
      status.remaining ?? null,
      status.unit,
      status.resetAt ?? null,
      status.secondsUntilReset ?? null,
      status.checkedAt,
      status.source,
      status.rawHeaders ? JSON.stringify(status.rawHeaders) : null,
      status.error ?? null
    );
  }

  getLatestQuotaStatus(provider = "nxtcodex"): QuotaStatus | null {
    const row = this.db.prepare(
      `SELECT * FROM nxtcodex_quota_history WHERE provider = ? ORDER BY checked_at DESC LIMIT 1`
    ).get(provider) as Row | undefined;
    if (!row) return null;
    return {
      provider: (row.provider as QuotaStatus["provider"]) || "nxtcodex",
      keyId: row.key_id ? String(row.key_id) : undefined,
      status: row.status as QuotaStatus["status"],
      total: row.total == null ? null : Number(row.total),
      used: row.used == null ? null : Number(row.used),
      remaining: row.remaining == null ? null : Number(row.remaining),
      unit: row.unit as QuotaStatus["unit"],
      resetAt: row.reset_at ? String(row.reset_at) : null,
      secondsUntilReset: row.seconds_until_reset == null ? null : Number(row.seconds_until_reset),
      checkedAt: String(row.checked_at),
      source: row.source as QuotaStatus["source"],
      rawHeaders: row.raw_headers_json ? JSON.parse(String(row.raw_headers_json)) : undefined,
      error: row.error ? String(row.error) : undefined
    };
  }

  getQuotaHistory(provider = "nxtcodex", limit = 50): QuotaStatus[] {
    const rows = this.db.prepare(
      `SELECT * FROM nxtcodex_quota_history WHERE provider = ? ORDER BY checked_at DESC LIMIT ?`
    ).all(provider, limit) as Row[];
    return rows.map((row) => ({
      provider: (row.provider as QuotaStatus["provider"]) || "nxtcodex",
      keyId: row.key_id ? String(row.key_id) : undefined,
      status: row.status as QuotaStatus["status"],
      total: row.total == null ? null : Number(row.total),
      used: row.used == null ? null : Number(row.used),
      remaining: row.remaining == null ? null : Number(row.remaining),
      unit: row.unit as QuotaStatus["unit"],
      resetAt: row.reset_at ? String(row.reset_at) : null,
      secondsUntilReset: row.seconds_until_reset == null ? null : Number(row.seconds_until_reset),
      checkedAt: String(row.checked_at),
      source: row.source as QuotaStatus["source"],
      rawHeaders: row.raw_headers_json ? JSON.parse(String(row.raw_headers_json)) : undefined,
      error: row.error ? String(row.error) : undefined
    }));
  }

  close(): void {
    this.db.close();
  }
}
