import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { matchProviderProcess, normalizeUsage, redactSecrets, resolveProject } from "@ltm/core";
import { createJsonLinesState, extractUsageLimits, parseJsonLines, parseStructuredUsage } from "@ltm/collectors";
import { MonitorDatabase } from "@ltm/database";
import { calculateCost } from "@ltm/token-estimator";

const temporaryPaths: string[] = [];
afterEach(async () => {
  for (const item of temporaryPaths.splice(0)) await rm(item, { recursive: true, force: true });
});

describe("token normalization", () => {
  it("uses the provider total without adding cache or reasoning twice", () => {
    const result = normalizeUsage({
      provider: "codex",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 70,
      reasoningTokens: 25,
      providerTotal: 140,
      timestamp: "2026-01-01T00:00:00.000Z"
    });
    expect(result.totalTokens).toBe(140);
    expect(result.cacheReadTokens).toBe(70);
    expect(result.reasoningTokens).toBe(25);
    expect(result.accuracy).toBe("exact");
  });

  it("marks component totals as derived", () => {
    const result = normalizeUsage({ provider: "claude", inputTokens: 10, outputTokens: 5 });
    expect(result.totalTokens).toBe(15);
    expect(result.accuracy).toBe("derived");
  });
});

describe("privacy", () => {
  it("redacts keys, authorization and user home paths", () => {
    const text = "authorization=Bearer secret-token api_key=top-secret C:\\Users\\alice\\project";
    const result = redactSecrets(text);
    expect(result).not.toContain("top-secret");
    expect(result).not.toContain("secret-token");
    expect(result).not.toContain("alice");
    expect(result).toContain("[REDACTED]");
  });
});

describe("process matching", () => {
  it("matches native and node-wrapped providers without broad node matches", () => {
    expect(matchProviderProcess({ name: "codex.exe" })).toBe("codex");
    expect(matchProviderProcess({ name: "node", command: "node C:\\tools\\claude\\cli.js" })).toBe("claude");
    expect(matchProviderProcess({ name: "node", command: "node server.js" })).toBeUndefined();
  });
});

describe("project resolution", () => {
  it("walks to a git root and returns repository metadata safely", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ltm-project-"));
    temporaryPaths.push(root);
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "packages", "app"), { recursive: true });
    const project = await resolveProject(
      { processCwd: path.join(root, "packages", "app") },
      async (_file, args) => ({ stdout: args.includes("remote.origin.url") ? "https://example.test/owner/repo.git\n" : "main\n", stderr: "" })
    );
    expect(project.path).toBe(await realpath(root));
    expect(project.name).toBe("repo");
    expect(project.gitBranch).toBe("main");
  });
});

describe("structured usage parsing", () => {
  it("parses a Codex cumulative token_count envelope and emits deltas", () => {
    const previousTotals = new Map<string, number>();
    const first = parseStructuredUsage({
      timestamp: "2026-01-01T00:00:00Z",
      session_id: "codex-fixture",
      payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: 100, output_tokens: 30, cached_input_tokens: 40, reasoning_tokens: 8, total_tokens: 130
      } } }
    }, "codex", { previousTotals });
    const second = parseStructuredUsage({
      timestamp: "2026-01-01T00:01:00Z",
      session_id: "codex-fixture",
      payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: 150, output_tokens: 45, cached_input_tokens: 40, reasoning_tokens: 12, total_tokens: 195
      } } }
    }, "codex", { previousTotals });
    expect(first?.totalTokens).toBe(130);
    expect(first?.cacheReadTokens).toBe(40);
    expect(second?.inputTokens).toBe(50);
    expect(second?.outputTokens).toBe(15);
    expect(second?.cacheReadTokens).toBe(0);
    expect(second?.totalTokens).toBe(65);
  });

  it("parses Claude message usage including cache fields", () => {
    const event = parseStructuredUsage({
      type: "assistant",
      timestamp: "2026-01-02T00:00:00Z",
      sessionId: "claude-fixture",
      cwd: path.join(os.tmpdir(), "fixture-project"),
      message: {
        model: "claude-sonnet-fixture",
        usage: {
          input_tokens: 120,
          output_tokens: 25,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 10
        }
      }
    }, "claude");
    expect(event?.model).toBe("claude-sonnet-fixture");
    expect(event?.cacheReadTokens).toBe(60);
    expect(event?.cacheWriteTokens).toBe(10);
    expect(event?.totalTokens).toBe(215);
    expect(event?.accuracy).toBe("derived");
    expect(event?.projectPath).toContain("fixture-project");
  });

  it("ignores unknown JSON formats", () => {
    expect(parseStructuredUsage({ type: "future-format", payload: { text: "not retained" } }, "codex")).toBeUndefined();
  });

  it("extracts sanitized Codex quota windows", () => {
    const limits = extractUsageLimits({
      timestamp: "2026-01-02T00:00:00Z",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 17, window_minutes: 10_080, resets_at: 1_767_312_000 }
        }
      }
    });
    expect(limits?.primary?.usedPercent).toBe(17);
    expect(limits?.primary?.windowMinutes).toBe(10_080);
    expect(limits?.primary?.resetsAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("reads only newly appended JSONL records after the initial scan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ltm-incremental-"));
    temporaryPaths.push(root);
    const sessionPath = path.join(root, "session.jsonl");
    const record = (timestamp: string, input: number, output: number) => JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } }
      }
    });
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "incremental-session", cwd: root } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex" } }),
      record("2026-01-01T00:00:00Z", 100, 30)
    ].join("\n") + "\n");
    const source = {
      id: "incremental-source",
      provider: "codex" as const,
      path: sessionPath,
      kind: "jsonl" as const,
      parserVersion: "test",
      exists: true
    };
    const state = createJsonLinesState();
    const initial = [];
    for await (const event of parseJsonLines(source, undefined, undefined, state)) initial.push(event);
    expect(initial).toHaveLength(1);
    expect(initial[0].totalTokens).toBe(130);
    expect(initial[0].model).toBe("gpt-5-codex");

    await appendFile(sessionPath, record("2026-01-01T00:01:00Z", 150, 45) + "\n");
    const appended = [];
    for await (const event of parseJsonLines(source, undefined, undefined, state)) appended.push(event);
    expect(appended).toHaveLength(1);
    expect(appended[0].totalTokens).toBe(65);

    const unchanged = [];
    for await (const event of parseJsonLines(source, undefined, undefined, state)) unchanged.push(event);
    expect(unchanged).toHaveLength(0);
  });
});

describe("database and aggregation", () => {
  it("deduplicates fingerprints and aggregates a time range", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ltm-db-"));
    temporaryPaths.push(root);
    const database = new MonitorDatabase(path.join(root, "test.sqlite"));
    database.updateSettings({ demoMode: false });
    const event = normalizeUsage({
      provider: "codex", inputTokens: 40, outputTokens: 10,
      timestamp: "2026-02-01T12:00:00.000Z"
    });
    expect(database.insertUsage(event)).toBe(true);
    expect(database.insertUsage({ ...event, id: "another-id" })).toBe(false);
    expect(database.summary({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-02T00:00:00.000Z" }).totalTokens).toBe(50);
    expect(database.summary({ from: "2026-02-03T00:00:00.000Z" }).totalTokens).toBe(0);
    database.close();
  });
});

describe("pricing", () => {
  it("calculates all priced components per million tokens", () => {
    const event = normalizeUsage({
      provider: "claude", model: "claude-test", inputTokens: 1_000_000,
      outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 20_000
    });
    expect(calculateCost(event, [{
      provider: "anthropic", modelPattern: "claude-test", inputPerMillion: 3,
      outputPerMillion: 15, cacheReadPerMillion: .3, cacheWritePerMillion: 3.75,
      effectiveFrom: "2026-01-01"
    }])).toBe(4.725);
  });

  it("does not price Codex cached input twice", () => {
    const event = normalizeUsage({
      provider: "codex",
      model: "gpt-5-codex",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 800_000,
      providerTotal: 1_000_000
    });
    expect(calculateCost(event, [{
      provider: "openai",
      modelPattern: "gpt-5",
      inputPerMillion: 1,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.1,
      effectiveFrom: "2026-01-01"
    }])).toBe(0.28);
  });
});
