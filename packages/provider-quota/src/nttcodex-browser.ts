import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderQuotaSnapshot, QuotaMetric } from "@ltm/shared-types";

const NTTCODEX_ORIGIN = "https://nttcodex.com";
const NTTCODEX_KEYS_URL = `${NTTCODEX_ORIGIN}/account/keys`;
const NTTCODEX_PAGE_URL = `${NTTCODEX_ORIGIN}/user/keys`;
const DEFAULT_REFRESH_SECONDS = 30;

type JsonRecord = Record<string, unknown>;
type BridgeState = "disconnected" | "starting" | "waiting-login" | "connected" | "error";

export interface NttCodexBrowserStatus {
  state: BridgeState;
  browser?: "chrome" | "edge" | "chromium";
  windowOpen: boolean;
  refreshSeconds: number;
  lastSyncedAt?: string;
  nextRefreshAt?: string;
  lastError?: string;
}

export interface NttCodexBrowserBridgeOptions {
  onSnapshot?: (snapshot: ProviderQuotaSnapshot) => void | Promise<void>;
  runtimeDir?: string;
  now?: () => Date;
}

interface BrowserExecutable {
  path: string;
  name: "chrome" | "edge" | "chromium";
}

interface DevToolsTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  result?: JsonRecord;
  error?: { message?: string };
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;

function finiteNonnegative(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function browserCandidates(): BrowserExecutable[] {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const localAppData = process.env.LOCALAPPDATA;
    const candidates: BrowserExecutable[] = [];
    if (programFiles) {
      candidates.push(
        { path: path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"), name: "chrome" },
        { path: path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"), name: "edge" }
      );
    }
    if (programFilesX86) {
      candidates.push(
        { path: path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"), name: "chrome" },
        { path: path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"), name: "edge" }
      );
    }
    if (localAppData) {
      candidates.push({ path: path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"), name: "chrome" });
    }
    return candidates;
  }
  if (process.platform === "darwin") {
    return [
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "chrome" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "edge" },
      { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "chromium" }
    ];
  }
  return [
    { path: "/usr/bin/google-chrome", name: "chrome" },
    { path: "/usr/bin/google-chrome-stable", name: "chrome" },
    { path: "/usr/bin/microsoft-edge", name: "edge" },
    { path: "/usr/bin/microsoft-edge-stable", name: "edge" },
    { path: "/usr/bin/chromium", name: "chromium" },
    { path: "/usr/bin/chromium-browser", name: "chromium" }
  ];
}

function findBrowserExecutable(): BrowserExecutable {
  const browser = browserCandidates().find((candidate) => existsSync(candidate.path));
  if (!browser) {
    throw new Error("Chrome, Edge, or Chromium was not found on this computer.");
  }
  return browser;
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: JsonRecord) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      try {
        const response = JSON.parse(String(event.data)) as CdpResponse;
        if (response.id === undefined) return;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error.message ?? "Browser command failed."));
        else pending.resolve(response.result ?? {});
      } catch {
        // Ignore browser events and malformed frames that are unrelated to a request.
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("The NTTCodex browser window was closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to the local browser.")), 8_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect to the local browser."));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(method: string, params: JsonRecord = {}): Promise<JsonRecord> {
    if (!this.isOpen) return Promise.reject(new Error("The NTTCodex browser window is not connected."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

export function parseNttCodexAccountKeys(
  body: unknown,
  date = new Date()
): ProviderQuotaSnapshot {
  const root = record(body);
  const nested = record(root?.data);
  const keys = Array.isArray(root?.keys) ? root.keys : Array.isArray(nested?.keys) ? nested.keys : undefined;
  const fetchedAt = date.toISOString();
  const unavailable = (error: string): ProviderQuotaSnapshot => ({
    providerId: "nttcodex",
    displayName: "NTTCodex",
    status: "unavailable",
    confidence: "none",
    partial: true,
    fetchedAt,
    endpoint: NTTCODEX_KEYS_URL,
    protocol: "unknown",
    metrics: [],
    sources: [],
    httpStatus: 200,
    error,
    warnings: []
  });

  if (!keys) return unavailable("NTTCodex returned an unrecognized account/keys response.");

  let dailyLimit = 0;
  let usedToday = 0;
  let monthlyLimit = 0;
  let limitedUsedMonth = 0;
  let meteredUsedMonth = 0;
  let dailyCount = 0;
  let monthlyLimitCount = 0;
  let meteredMonthCount = 0;
  let incomplete = false;

  for (const rawKey of keys) {
    const key = record(rawKey);
    if (!key) {
      incomplete = true;
      continue;
    }
    const limit = finiteNonnegative(key.daily_token_limit);
    const today = finiteNonnegative(key.used_today);
    const monthLimit = finiteNonnegative(key.monthly_token_limit);
    const month = finiteNonnegative(key.used_month);
    if (limit !== undefined && today !== undefined) {
      dailyLimit += limit;
      usedToday += today;
      dailyCount += 1;
    } else {
      incomplete = true;
    }
    if (monthLimit !== undefined && monthLimit > 0) {
      monthlyLimit += monthLimit;
      monthlyLimitCount += 1;
      if (month !== undefined) limitedUsedMonth += month;
      else incomplete = true;
    } else if (month !== undefined) {
      meteredUsedMonth += month;
      meteredMonthCount += 1;
    }
  }

  const metrics: QuotaMetric[] = [];
  if (dailyCount > 0) {
    metrics.push({
      kind: "tokens",
      label: `Today · ${dailyCount} API key${dailyCount === 1 ? "" : "s"}`,
      limit: dailyLimit,
      used: usedToday,
      remaining: Math.max(0, dailyLimit - usedToday),
      unit: "tokens",
      window: "day"
    });
  }
  if (monthlyLimitCount > 0) {
    metrics.push({
      kind: "tokens",
      label: "This month · limited packages",
      limit: monthlyLimit,
      used: limitedUsedMonth,
      remaining: Math.max(0, monthlyLimit - limitedUsedMonth),
      unit: "tokens",
      window: "month"
    });
  }
  if (meteredMonthCount > 0) {
    metrics.push({
      kind: "observed-usage",
      label: "This month · metered usage",
      used: meteredUsedMonth,
      unit: "tokens",
      window: "month"
    });
  }

  if (keys.length === 0) {
    return {
      ...unavailable("The signed-in NTTCodex account has no API keys."),
      status: "available",
      confidence: "high",
      partial: false,
      sources: [{
        kind: "provider-dashboard",
        label: "NTTCodex account keys dashboard",
        url: NTTCODEX_KEYS_URL,
        isOfficial: true,
        observedAt: fetchedAt
      }],
      warnings: ["No API keys were returned for this account."]
    };
  }
  if (metrics.length === 0) {
    return unavailable("NTTCodex returned API keys, but no recognized quota fields were present.");
  }

  return {
    providerId: "nttcodex",
    displayName: "NTTCodex",
    status: incomplete ? "partial" : "available",
    confidence: "high",
    partial: incomplete,
    fetchedAt,
    endpoint: NTTCODEX_KEYS_URL,
    protocol: "unknown",
    metrics,
    sources: [{
      kind: "provider-dashboard",
      label: "NTTCodex account keys dashboard",
      url: NTTCODEX_KEYS_URL,
      isOfficial: true,
      observedAt: fetchedAt
    }],
    httpStatus: 200,
    warnings: [
      "Values are aggregated from the signed-in account's API keys; API key values and account details are discarded.",
      "Keep the dedicated NTTCodex browser window open for live refresh."
    ]
  };
}

export class NttCodexBrowserBridge {
  private readonly runtimeDir: string;
  private readonly profileDir: string;
  private readonly now: () => Date;
  private readonly onSnapshot?: (snapshot: ProviderQuotaSnapshot) => void | Promise<void>;
  private browserProcess?: ChildProcess;
  private client?: CdpClient;
  private timer?: NodeJS.Timeout;
  private connectPromise?: Promise<ProviderQuotaSnapshot>;
  private state: BridgeState = "disconnected";
  private browserName?: BrowserExecutable["name"];
  private refreshSeconds = DEFAULT_REFRESH_SECONDS;
  private lastSyncedAt?: string;
  private nextRefreshAt?: string;
  private lastError?: string;

  constructor(options: NttCodexBrowserBridgeOptions = {}) {
    this.runtimeDir = options.runtimeDir ?? path.join(os.homedir(), ".local-token-monitor");
    this.profileDir = path.join(this.runtimeDir, "browser", "nttcodex");
    this.now = options.now ?? (() => new Date());
    this.onSnapshot = options.onSnapshot;
  }

  status(): NttCodexBrowserStatus {
    return {
      state: this.state,
      browser: this.browserName,
      windowOpen: Boolean(this.client?.isOpen || (this.browserProcess && this.browserProcess.exitCode === null)),
      refreshSeconds: this.refreshSeconds,
      lastSyncedAt: this.lastSyncedAt,
      nextRefreshAt: this.nextRefreshAt,
      lastError: this.lastError
    };
  }

  async connect(refreshSeconds = DEFAULT_REFRESH_SECONDS): Promise<ProviderQuotaSnapshot> {
    this.refreshSeconds = Math.max(10, Math.min(300, Math.floor(refreshSeconds)));
    if (this.connectPromise) return this.connectPromise;
    if (this.client?.isOpen && this.state === "connected") return this.refresh();
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<ProviderQuotaSnapshot> {
    this.state = "starting";
    this.lastError = undefined;
    try {
      await mkdir(this.profileDir, { recursive: true });
      this.client = await this.connectExistingBrowser().catch(() => undefined);
      if (!this.client) {
        const browser = findBrowserExecutable();
        this.browserName = browser.name;
        const activePortPath = path.join(this.profileDir, "DevToolsActivePort");
        await rm(activePortPath, { force: true });
        this.browserProcess = spawn(browser.path, [
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${this.profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          `--app=${NTTCODEX_PAGE_URL}`
        ], {
          detached: false,
          stdio: "ignore",
          windowsHide: true
        });
        this.browserProcess.once("exit", () => {
          this.stopTimer();
          this.client?.close();
          this.client = undefined;
          this.browserProcess = undefined;
          if (this.state !== "error") this.state = "disconnected";
        });
        this.client = await this.waitForBrowserTarget();
      }
      this.state = "waiting-login";
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const result = await this.readAccountKeys();
        if (result.status === 200) {
          const snapshot = parseNttCodexAccountKeys(result.body, this.now());
          if (snapshot.status === "unavailable") throw new Error(snapshot.error);
          await this.acceptSnapshot(snapshot);
          this.startTimer();
          return snapshot;
        }
        if (result.status !== 401 && result.status !== 403) {
          throw new Error(`NTTCodex returned HTTP ${result.status}.`);
        }
        await delay(1_500);
      }
      throw new Error("Login timed out. Click Connect again when you are ready to sign in.");
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : "Could not connect to NTTCodex.";
      if (error instanceof Error) throw error;
      throw new Error(this.lastError, { cause: error });
    }
  }

  async refresh(): Promise<ProviderQuotaSnapshot> {
    if (!this.client?.isOpen) {
      this.state = "disconnected";
      throw new Error("The NTTCodex browser window is not open. Connect it again.");
    }
    const result = await this.readAccountKeys();
    if (result.status === 401 || result.status === 403) {
      this.state = "waiting-login";
      this.lastError = "The NTTCodex web session expired. Sign in again in the dedicated browser window.";
      throw new Error(this.lastError);
    }
    if (result.status !== 200) throw new Error(`NTTCodex returned HTTP ${result.status}.`);
    const snapshot = parseNttCodexAccountKeys(result.body, this.now());
    if (snapshot.status === "unavailable") throw new Error(snapshot.error);
    await this.acceptSnapshot(snapshot);
    return snapshot;
  }

  async disconnect(): Promise<void> {
    this.stopTimer();
    const client = this.client;
    this.client = undefined;
    this.state = "disconnected";
    this.lastError = undefined;
    this.nextRefreshAt = undefined;
    if (client?.isOpen) {
      await client.send("Browser.close").catch(() => undefined);
      client.close();
    }
    if (this.browserProcess && this.browserProcess.exitCode === null) {
      this.browserProcess.kill();
    }
    this.browserProcess = undefined;
  }

  private async acceptSnapshot(snapshot: ProviderQuotaSnapshot): Promise<void> {
    this.state = "connected";
    this.lastError = undefined;
    this.lastSyncedAt = snapshot.fetchedAt;
    this.nextRefreshAt = new Date(this.now().getTime() + this.refreshSeconds * 1_000).toISOString();
    await this.onSnapshot?.(snapshot);
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.lastError = error instanceof Error ? error.message : "NTTCodex refresh failed.";
        if (!this.client?.isOpen) this.state = "disconnected";
      });
    }, this.refreshSeconds * 1_000);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async connectExistingBrowser(): Promise<CdpClient | undefined> {
    const activePortPath = path.join(this.profileDir, "DevToolsActivePort");
    const activePort = await readFile(activePortPath, "utf8");
    const port = Number(activePort.split(/\r?\n/, 1)[0]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    return this.connectToPageTarget(port);
  }

  private async waitForBrowserTarget(): Promise<CdpClient> {
    const activePortPath = path.join(this.profileDir, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const activePort = await readFile(activePortPath, "utf8");
        const port = Number(activePort.split(/\r?\n/, 1)[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          return await this.connectToPageTarget(port);
        }
      } catch (error) {
        lastError = error;
      }
      await delay(150);
    }
    throw lastError instanceof Error ? lastError : new Error("The browser did not become ready.");
  }

  private async connectToPageTarget(port: number): Promise<CdpClient> {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) throw new Error("The local browser debugger did not respond.");
    const targets = await response.json() as DevToolsTarget[];
    const target = targets.find((candidate) =>
      candidate.type === "page" &&
      typeof candidate.url === "string" &&
      candidate.url.startsWith(NTTCODEX_ORIGIN) &&
      candidate.webSocketDebuggerUrl
    ) ?? targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("The NTTCodex browser page is not ready.");
    return CdpClient.connect(target.webSocketDebuggerUrl);
  }

  private async readAccountKeys(): Promise<{ status: number; body: unknown }> {
    if (!this.client?.isOpen) throw new Error("The NTTCodex browser window was closed.");
    const expression = `(async () => {
      const response = await fetch(${JSON.stringify(NTTCODEX_KEYS_URL)}, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { "accept": "application/json" }
      });
      let body = null;
      try { body = await response.json(); } catch {}
      return { status: response.status, body };
    })()`;
    try {
      const evaluation = await this.client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true
      });
      const remoteResult = record(evaluation.result);
      const value = record(remoteResult?.value);
      const status = finiteNonnegative(value?.status);
      if (status !== undefined) return { status, body: value?.body };
    } catch {
      // A page may still be creating its default JavaScript context.
    }
    return this.loadAccountKeysResource();
  }

  private async loadAccountKeysResource(): Promise<{ status: number; body: unknown }> {
    if (!this.client?.isOpen) throw new Error("The NTTCodex browser window was closed.");
    try {
      const frameTreeResponse = await this.client.send("Page.getFrameTree");
      const frameTree = record(frameTreeResponse.frameTree);
      const frame = record(frameTree?.frame);
      const frameId = typeof frame?.id === "string" ? frame.id : undefined;
      if (!frameId) throw new Error("The browser page frame is unavailable.");
      const loaded = await this.client.send("Network.loadNetworkResource", {
        frameId,
        url: NTTCODEX_KEYS_URL,
        options: {
          disableCache: true,
          includeCredentials: true
        }
      });
      const resource = record(loaded.resource);
      const status = finiteNonnegative(resource?.httpStatusCode);
      if (!resource?.success || status === undefined) {
        throw new Error("The browser could not load the quota resource.");
      }

      let text = typeof resource.content === "string" ? resource.content : "";
      const stream = typeof resource.stream === "string" ? resource.stream : undefined;
      if (!text && stream) {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        try {
          while (true) {
            const chunk = await this.client.send("IO.read", { handle: stream, size: 64 * 1024 });
            const data = typeof chunk.data === "string" ? chunk.data : "";
            const bytes = chunk.base64Encoded
              ? Buffer.from(data, "base64")
              : Buffer.from(data, "utf8");
            totalBytes += bytes.byteLength;
            if (totalBytes > 1_000_000) throw new Error("The quota response exceeded 1 MB.");
            chunks.push(bytes);
            if (chunk.eof === true) break;
          }
        } finally {
          await this.client.send("IO.close", { handle: stream }).catch(() => undefined);
        }
        text = Buffer.concat(chunks).toString("utf8");
      }

      if (!text) return { status, body: null };
      try {
        return { status, body: JSON.parse(text) };
      } catch {
        // A signed-out resource load commonly redirects to an HTML login page.
        return { status: status === 200 ? 401 : status, body: null };
      }
    } catch (error) {
      throw new Error("The NTTCodex page blocked the quota request.", { cause: error });
    }
  }
}
