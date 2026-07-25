import { readFileSync } from "node:fs";
import { mkdir, open as openFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import open from "open";

const command = process.argv.slice(2).find((argument) => !argument.startsWith("-")) ?? "start";
const runtimeDir = path.join(os.homedir(), ".local-token-monitor");
const statePath = path.join(runtimeDir, "server.json");
const startLockPath = path.join(runtimeDir, "start.lock");
const noOpen = process.argv.includes("--no-open");
const forceOpen = process.argv.includes("--open");

function state(): { pid: number; host: string; port: number } | undefined {
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return undefined; }
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForServer(url: string, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // The detached server may still be opening SQLite and binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function printProviderStatus(url: string): Promise<void> {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return;
    const status = await response.json() as {
      providers?: Array<{
        provider: "codex" | "claude";
        running?: boolean;
        installation?: { installed?: boolean; version?: string };
      }>;
    };
    for (const provider of ["codex", "claude"] as const) {
      const item = status.providers?.find((candidate) => candidate.provider === provider);
      const label = provider === "codex" ? "Codex" : "Claude Code";
      const stateLabel = item?.running ? "running" : item?.installation?.installed ? "detected" : "not detected";
      const version = item?.installation?.version ? ` · v${item.installation.version}` : "";
      console.log(`  ${label}: ${stateLabel}${version}`);
    }
  } catch {
    console.log("  Provider status will appear in Diagnostics.");
  }
}

async function openDashboard(url: string): Promise<void> {
  if (noOpen) return;
  try {
    await open(url);
  } catch {
    console.log(`Open this address in your browser: ${url}`);
  }
}

async function reportRunning(url: string): Promise<void> {
  console.log("Local Token Monitor is already running");
  console.log(`  Dashboard: ${url}`);
  await printProviderStatus(url);
  if (forceOpen) await openDashboard(url);
  else console.log("  Run `local-token-monitor open` to open another browser tab.");
}

async function main(): Promise<void> {
  if (command === "start") {
    const existing = state();
    if (existing && running(existing.pid)) {
      const url = `http://${existing.host}:${existing.port}`;
      await reportRunning(url);
      return;
    }
    const foreground = process.argv.includes("--foreground") || process.env.LTM_FOREGROUND === "true";
    if (!foreground && import.meta.url.endsWith("/cli.js")) {
      await mkdir(runtimeDir, { recursive: true });
      const url = `http://127.0.0.1:${process.env.LTM_PORT ?? 3456}`;
      let lock: Awaited<ReturnType<typeof openFile>> | undefined;
      try {
        try {
          lock = await openFile(startLockPath, "wx");
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
          if (await waitForServer(url)) {
            await reportRunning(url);
            return;
          }
          await rm(startLockPath, { force: true });
          lock = await openFile(startLockPath, "wx");
        }
        await rm(statePath, { force: true });
        const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "server.js")], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        child.unref();
        if (!await waitForServer(url)) {
          console.error("Local Token Monitor did not become ready. Run `npx local-token-monitor doctor` for diagnostics.");
          process.exitCode = 1;
          return;
        }
      } finally {
        await lock?.close();
        await rm(startLockPath, { force: true });
      }
      console.log("Local Token Monitor is ready");
      console.log(`  Dashboard: ${url}`);
      await printProviderStatus(url);
      await openDashboard(url);
      return;
    }
    const [
      { startServer },
      { CodexAdapter },
      { ClaudeAdapter }
    ] = await Promise.all([
      import("./index.ts"),
      import("@ltm/provider-codex"),
      import("@ltm/provider-claude")
    ]);
    const { url } = await startServer();
    const [codex, claude] = await Promise.all([new CodexAdapter().detectInstallation(), new ClaudeAdapter().detectInstallation()]);
    console.log(`Local Token Monitor: ${url}`);
    console.log(`Codex: ${codex.installed ? `detected (${codex.version ?? "version unknown"})` : "not detected"}`);
    console.log(`Claude Code: ${claude.installed ? `detected (${claude.version ?? "version unknown"})` : "not detected"}`);
    await openDashboard(url);
    return;
  }
  if (command === "stop") {
    const current = state();
    if (!current || !running(current.pid)) {
      console.log("Local Token Monitor is not running.");
      return;
    }
    process.kill(current.pid, "SIGTERM");
    await rm(statePath, { force: true });
    console.log("Local Token Monitor stopped.");
    return;
  }
  if (command === "status") {
    const current = state();
    console.log(current && running(current.pid)
      ? `Running at http://${current.host}:${current.port} (PID ${current.pid})`
      : "Not running");
    return;
  }
  if (command === "open") {
    const current = state();
    await open(current ? `http://${current.host}:${current.port}` : "http://127.0.0.1:3456");
    return;
  }
  if (command === "doctor") {
    const [{ CodexAdapter }, { ClaudeAdapter }] = await Promise.all([
      import("@ltm/provider-codex"),
      import("@ltm/provider-claude")
    ]);
    const [codex, claude] = await Promise.all([new CodexAdapter().getDiagnostics(), new ClaudeAdapter().getDiagnostics()]);
    console.log(JSON.stringify({
      platform: process.platform,
      release: os.release(),
      nodeVersion: process.version,
      localOnlyDefault: true,
      collectors: [codex, claude]
    }, null, 2));
    return;
  }
  if (command === "export") {
    const { MonitorDatabase } = await import("@ltm/database");
    const database = new MonitorDatabase();
    const format = process.argv.includes("--csv") ? "csv" : "json";
    const outputPath = path.resolve(process.cwd(), `local-token-usage.${format}`);
    await writeFile(outputPath, database.exportData(format));
    database.close();
    console.log(`Exported redacted usage metadata to ${outputPath}`);
    return;
  }
  if (command === "reset") {
    if (!process.argv.includes("--yes")) {
      console.error('Reset requires --yes. This deletes locally stored usage data.');
      process.exitCode = 2;
      return;
    }
    const { MonitorDatabase } = await import("@ltm/database");
    const database = new MonitorDatabase();
    database.reset(false);
    database.close();
    console.log("Local data reset. Demo data was restored.");
    return;
  }
  console.log("Usage: local-token-monitor [start|stop|status|open|doctor|export|reset]");
}

void main();
