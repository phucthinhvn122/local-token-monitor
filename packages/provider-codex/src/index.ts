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
  ProviderUsageLimits,
  TokenUsageEvent
} from "@ltm/shared-types";
import { fingerprint, scanProcesses } from "@ltm/core";
import { createJsonLinesState, parseJsonLines, recentFiles, type JsonLinesParseState } from "@ltm/collectors";

const execFileAsync = promisify(execFile);

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true).catch(() => false);
}

async function locate(command: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const names = [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const cleanDirectory = directory.replace(/^"|"$/g, "");
      for (const name of names) {
        const candidate = path.join(cleanDirectory, name);
        if (await exists(candidate)) return candidate;
      }
    }
    return undefined;
  }
  let result: { stdout: string };
  try { result = await execFileAsync("which", [command], { windowsHide: true }); } catch { result = { stdout: "" }; }
  const paths = result.stdout.split(/\r?\n/).filter(Boolean);
  return paths[0];
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

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private lastParseError?: string;
  private watchedFiles = 0;
  private collectedEvents = 0;
  private duplicateEvents = 0;
  private usageLimits?: ProviderUsageLimits;
  private parseStates = new Map<string, JsonLinesParseState>();
  private installationCache?: { expiresAt: number; value: InstallationInfo };

  constructor(private readonly customPaths: string[] = []) {}

  private candidateRoots(): string[] {
    const home = os.homedir();
    const configured = (process.env.CODEX_HOME ? [process.env.CODEX_HOME] : []);
    return [...new Set([
      ...configured,
      ...this.customPaths,
      path.join(home, ".codex", "sessions"),
      path.join(home, ".codex", "archived_sessions"),
      path.join(home, ".codex", "log"),
      ...(process.platform === "win32" ? [path.join(process.env.APPDATA ?? "", "codex")] : []),
      ...(process.platform === "linux" ? [path.join(home, ".local", "share", "codex")] : [])
    ].filter(Boolean))];
  }

  async detectInstallation(): Promise<InstallationInfo> {
    if (this.installationCache && this.installationCache.expiresAt > Date.now()) {
      return this.installationCache.value;
    }
    const executablePath = await locate("codex");
    if (!executablePath) {
      const value = { installed: false };
      this.installationCache = { expiresAt: Date.now() + 60_000, value };
      return value;
    }
    const version = await readVersion(executablePath, "codex");
    const value = {
      installed: true,
      executablePath,
      version: version.replace(/^codex-cli\s*/i, "") || undefined,
      warning: "Session formats are discovered defensively and may change between Codex versions."
    };
    this.installationCache = { expiresAt: Date.now() + 300_000, value };
    return value;
  }

  async discoverSources(): Promise<CollectorSource[]> {
    const roots = [];
    for (const candidate of this.candidateRoots()) if (await exists(candidate)) roots.push(candidate);
    const files = await recentFiles(roots);
    this.watchedFiles = files.length;
    return files.map((file) => ({
      id: fingerprint(["codex", file]),
      provider: "codex",
      path: file,
      kind: path.extname(file) === ".jsonl" ? "jsonl" : "json",
      parserVersion: "codex-usage-v1",
      exists: true
    }));
  }

  async detectRunningSessions(): Promise<DetectedSession[]> {
    const processes = (await scanProcesses()).filter((item) => item.provider === "codex");
    return processes.map((process) => ({
      id: `codex-process-${process.pid}`,
      provider: "codex",
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
      (limits) => {
        if (!this.usageLimits || limits.updatedAt > this.usageLimits.updatedAt) this.usageLimits = limits;
      },
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
      provider: "codex",
      installation,
      candidatePaths,
      running: (await this.detectRunningSessions()).length > 0,
      watchedFiles: this.watchedFiles,
      collectedEvents: this.collectedEvents,
      duplicateEvents: this.duplicateEvents,
      usageLimits: this.usageLimits,
      lastParseError: this.lastParseError,
      warning: installation.warning
    };
  }
}
