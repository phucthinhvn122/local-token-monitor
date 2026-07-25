import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type {
  AdapterDiagnostics,
  CollectorSource,
  DetectedSession,
  InstallationInfo,
  ProviderAdapter,
  TokenUsageEvent
} from "@ltm/shared-types";
import { fingerprint, scanProcesses } from "@ltm/core";
import { createJsonLinesState, parseJsonLines, recentFiles, type JsonLinesParseState } from "@ltm/collectors";

const execFileAsync = promisify(execFile);
const exists = (candidate: string) => access(candidate).then(() => true).catch(() => false);

async function locate(command: string): Promise<string | undefined> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  let result: { stdout: string };
  try { result = await execFileAsync(locator, [command]); } catch { result = { stdout: "" }; }
  const paths = result.stdout.split(/\r?\n/).filter(Boolean);
  return paths.find((item) => /\.exe$/i.test(item) && !/\\WindowsApps\\/i.test(item))
    ?? paths.find((item) => /\.cmd$/i.test(item))
    ?? paths.find((item) => /\.exe$/i.test(item))
    ?? paths[0];
}

async function readVersion(executablePath: string, commandName: string): Promise<string> {
  try {
    const options = { timeout: 3000, windowsHide: true };
    const result = process.platform === "win32" && !/\.exe$/i.test(executablePath)
      ? await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${commandName} --version`], options)
      : await execFileAsync(executablePath, ["--version"], options);
    return result.stdout.trim();
  } catch {
    return "";
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  private lastParseError?: string;
  private watchedFiles = 0;
  private collectedEvents = 0;
  private duplicateEvents = 0;
  private parseStates = new Map<string, JsonLinesParseState>();

  constructor(private readonly customPaths: string[] = []) {}

  private candidateRoots(): string[] {
    const home = os.homedir();
    return [...new Set([
      ...this.customPaths,
      path.join(home, ".claude", "projects"),
      path.join(home, ".claude", "sessions"),
      path.join(home, ".config", "claude", "projects"),
      ...(process.platform === "win32"
        ? [path.join(process.env.APPDATA ?? "", "Claude"), path.join(process.env.LOCALAPPDATA ?? "", "Claude")]
        : [path.join(home, ".local", "share", "claude")])
    ].filter(Boolean))];
  }

  async detectInstallation(): Promise<InstallationInfo> {
    const executablePath = await locate("claude");
    if (!executablePath) return { installed: false };
    const version = await readVersion(executablePath, "claude");
    return {
      installed: true,
      executablePath,
      version: version.split(/\s+/)[0] || undefined,
      warning: "Cache usage is reported only when present in Claude session metadata."
    };
  }

  async discoverSources(): Promise<CollectorSource[]> {
    const roots = [];
    for (const candidate of this.candidateRoots()) if (await exists(candidate)) roots.push(candidate);
    const files = await recentFiles(roots);
    this.watchedFiles = files.length;
    return files.map((file) => ({
      id: fingerprint(["claude", file]),
      provider: "claude",
      path: file,
      kind: path.extname(file) === ".jsonl" ? "jsonl" : "json",
      parserVersion: "claude-message-usage-v1",
      exists: true
    }));
  }

  async detectRunningSessions(): Promise<DetectedSession[]> {
    return (await scanProcesses()).filter((item) => item.provider === "claude").map((process) => ({
      id: `claude-process-${process.pid}`,
      provider: "claude",
      processId: process.pid,
      startedAt: process.startedAt ?? new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      status: "running"
    }));
  }

  async *parseSource(source: CollectorSource): AsyncIterable<TokenUsageEvent> {
    let parseState = this.parseStates.get(source.path);
    if (!parseState) {
      parseState = createJsonLinesState();
      this.parseStates.set(source.path, parseState);
    }
    for await (const event of parseJsonLines(
      source,
      (error) => { this.lastParseError = error; },
      undefined,
      parseState
    )) {
      this.collectedEvents++;
      yield event;
    }
  }

  markDuplicate(): void { this.duplicateEvents++; }

  async getDiagnostics(): Promise<AdapterDiagnostics> {
    const installation = await this.detectInstallation();
    const candidatePaths = await Promise.all(this.candidateRoots().map(async (candidate) => ({ path: candidate, exists: await exists(candidate) })));
    return {
      provider: "claude",
      installation,
      candidatePaths,
      running: (await this.detectRunningSessions()).length > 0,
      watchedFiles: this.watchedFiles,
      collectedEvents: this.collectedEvents,
      duplicateEvents: this.duplicateEvents,
      lastParseError: this.lastParseError,
      warning: installation.warning
    };
  }
}
