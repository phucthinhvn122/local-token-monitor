import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexConfig } from "../packages/shared/src/codex-config.js";

/**
 * Executes the generated bash installer for real against a throwaway
 * CODEX_HOME. A config generator that produces syntactically broken shell is
 * the single most likely way this feature silently breaks, and only running it
 * catches that.
 */

const BASE = {
  gatewayBaseUrl: "https://gateway.example.com",
  apiKey: "sk-cgw-INSTALLTEST1234567890",
  model: "gpt-5-codex",
  wireApi: "chat" as const
};

const created: string[] = [];

function runInstaller(mode: "provider" | "openai", options: { seedExisting?: boolean } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "cgw-home-"));
  created.push(home);
  const codexHome = path.join(home, ".codex");

  if (options.seedExisting) {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), "# pre-existing user config\nmodel = \"old\"\n");
    writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"old-key"}\n');
  }

  const bundle = buildCodexConfig(BASE, mode);
  const scriptPath = path.join(home, "install.sh");
  writeFileSync(scriptPath, bundle.installBash, { mode: 0o755 });

  execFileSync("bash", [scriptPath], {
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    stdio: "pipe"
  });

  return { home, codexHome, bundle };
}

afterEach(() => {
  // Directories live under the OS temp dir and are small; leaving them is fine,
  // but clearing the list keeps the array from growing across the suite.
  created.length = 0;
});

describe("generated bash installer", () => {
  it("runs without error and writes config.toml in provider mode", () => {
    const { codexHome, bundle } = runInstaller("provider");
    const written = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(written.trim()).toBe(bundle.configToml.trim());
    expect(written).toContain("[model_providers.codex_gateway]");
  });

  it("does not create auth.json in provider mode", () => {
    const { codexHome } = runInstaller("provider");
    expect(existsSync(path.join(codexHome, "auth.json"))).toBe(false);
  });

  it("appends the export line to the shell profile in provider mode", () => {
    const { home } = runInstaller("provider");
    const profile = readFileSync(path.join(home, ".bashrc"), "utf8");
    expect(profile).toContain("export CODEX_GATEWAY_API_KEY=");
    expect(profile).toContain(BASE.apiKey);
  });

  it("writes both files in openai mode", () => {
    const { codexHome } = runInstaller("openai");
    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain("openai_base_url");
    expect(JSON.parse(readFileSync(path.join(codexHome, "auth.json"), "utf8"))).toEqual({
      OPENAI_API_KEY: BASE.apiKey
    });
  });

  it("backs up existing files before overwriting them", () => {
    const { codexHome } = runInstaller("openai", { seedExisting: true });
    const backups = readdirSync(codexHome).filter((name) => name.includes(".bak."));

    expect(backups.some((name) => name.startsWith("config.toml.bak."))).toBe(true);
    expect(backups.some((name) => name.startsWith("auth.json.bak."))).toBe(true);

    // The backup must hold the *old* content, not the newly written one.
    const oldConfig = backups.find((name) => name.startsWith("config.toml.bak."))!;
    expect(readFileSync(path.join(codexHome, oldConfig), "utf8")).toContain("pre-existing user config");
  });

  it("succeeds on a machine with no ~/.codex directory at all", () => {
    const { codexHome } = runInstaller("provider");
    expect(existsSync(codexHome)).toBe(true);
  });

  it("is idempotent — running twice leaves one valid config and no duplicate export", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cgw-home-"));
    const codexHome = path.join(home, ".codex");
    const bundle = buildCodexConfig(BASE, "provider");
    const scriptPath = path.join(home, "install.sh");
    writeFileSync(scriptPath, bundle.installBash, { mode: 0o755 });

    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
    execFileSync("bash", [scriptPath], { env, stdio: "pipe" });
    execFileSync("bash", [scriptPath], { env, stdio: "pipe" });

    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8").trim()).toBe(bundle.configToml.trim());
    const exports = readFileSync(path.join(home, ".bashrc"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("export CODEX_GATEWAY_API_KEY="));
    expect(exports).toHaveLength(1);
  });

  it("handles a key containing shell metacharacters", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cgw-home-"));
    const codexHome = path.join(home, ".codex");
    const nasty = `sk-cgw-a'b"c$d\`e;f`;
    const bundle = buildCodexConfig({ ...BASE, apiKey: nasty }, "openai");
    const scriptPath = path.join(home, "install.sh");
    writeFileSync(scriptPath, bundle.installBash, { mode: 0o755 });

    execFileSync("bash", [scriptPath], { env: { ...process.env, HOME: home, CODEX_HOME: codexHome }, stdio: "pipe" });

    // The heredoc is quoted, so the key must survive byte-for-byte with no
    // shell expansion of $, backtick or quote characters.
    expect(JSON.parse(readFileSync(path.join(codexHome, "auth.json"), "utf8")).OPENAI_API_KEY).toBe(nasty);
  });
});
