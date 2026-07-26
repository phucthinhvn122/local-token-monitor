import { describe, expect, it } from "vitest";
import {
  buildCodexConfig,
  codexManualSteps,
  gatewayApiBaseUrl,
  normalizeOrigin,
  shellSingleQuote,
  tomlKey,
  tomlString
} from "../packages/shared/src/codex-config.js";

const BASE = {
  gatewayBaseUrl: "https://gateway.example.com",
  apiKey: "sk-cgw-TESTKEY123456",
  model: "gpt-5-codex",
  wireApi: "chat" as const
};

describe("URL normalisation", () => {
  it("strips trailing slashes", () => {
    expect(normalizeOrigin("https://gw.test///")).toBe("https://gw.test");
  });

  it("appends /v1 exactly once", () => {
    expect(gatewayApiBaseUrl("https://gw.test")).toBe("https://gw.test/v1");
    expect(gatewayApiBaseUrl("https://gw.test/")).toBe("https://gw.test/v1");
    expect(gatewayApiBaseUrl("https://gw.test/v1")).toBe("https://gw.test/v1");
  });
});

describe("TOML escaping", () => {
  it("escapes quotes and backslashes in basic strings", () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("quotes keys that are not bare-safe", () => {
    expect(tomlKey("my_gateway")).toBe("my_gateway");
    expect(tomlKey("my gateway")).toBe('"my gateway"');
  });
});

describe("provider mode (default)", () => {
  const bundle = buildCodexConfig(BASE, "provider");

  it("declares a dedicated model provider pointing at the gateway", () => {
    expect(bundle.configToml).toContain('model = "gpt-5-codex"');
    expect(bundle.configToml).toContain('model_provider = "codex_gateway"');
    expect(bundle.configToml).toContain("[model_providers.codex_gateway]");
    expect(bundle.configToml).toContain('base_url = "https://gateway.example.com/v1"');
    expect(bundle.configToml).toContain('wire_api = "chat"');
  });

  it("references the key by environment variable and never inlines it", () => {
    expect(bundle.configToml).toContain('env_key = "CODEX_GATEWAY_API_KEY"');
    expect(bundle.configToml).not.toContain(BASE.apiKey);
  });

  it("writes no auth.json", () => {
    expect(bundle.authJson).toBeNull();
  });

  it("exports the key for both shells", () => {
    expect(bundle.envExportBash).toBe(`export CODEX_GATEWAY_API_KEY='${BASE.apiKey}'`);
    expect(bundle.envExportPowershell).toBe(`$env:CODEX_GATEWAY_API_KEY = '${BASE.apiKey}'`);
  });

  it("honours a custom provider id and env key", () => {
    const custom = buildCodexConfig(
      { ...BASE, providerId: "my_pool", providerName: "My Pool", envKey: "MY_POOL_KEY" },
      "provider"
    );
    expect(custom.configToml).toContain("[model_providers.my_pool]");
    expect(custom.configToml).toContain('name = "My Pool"');
    expect(custom.configToml).toContain('env_key = "MY_POOL_KEY"');
  });
});

describe("openai override mode", () => {
  const bundle = buildCodexConfig(BASE, "openai");

  it("overrides the built-in provider base URL", () => {
    expect(bundle.configToml).toContain('model_provider = "openai"');
    expect(bundle.configToml).toContain('openai_base_url = "https://gateway.example.com/v1"');
    expect(bundle.configToml).not.toContain("[model_providers.");
  });

  it("writes the key into auth.json in the shape codex login produces", () => {
    expect(bundle.authJson).not.toBeNull();
    expect(JSON.parse(bundle.authJson!)).toEqual({ OPENAI_API_KEY: BASE.apiKey });
  });

  it("keeps the key out of config.toml", () => {
    expect(bundle.configToml).not.toContain(BASE.apiKey);
  });
});

describe("install scripts", () => {
  it("backs up existing files before overwriting them", () => {
    const bundle = buildCodexConfig(BASE, "openai");
    expect(bundle.installBash).toContain('backup "$CODEX_HOME/config.toml"');
    expect(bundle.installBash).toContain('backup "$CODEX_HOME/auth.json"');
    expect(bundle.installPowershell).toContain("Backup-CgwFile");
    expect(bundle.installBash).toContain("cp \"$1\" \"$1.bak.");
  });

  it("targets CODEX_HOME with a ~/.codex fallback", () => {
    const bundle = buildCodexConfig(BASE, "provider");
    expect(bundle.installBash).toContain('CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"');
    expect(bundle.installPowershell).toContain("$env:CODEX_HOME");
  });

  it("aborts on the first failure rather than half-writing a config", () => {
    expect(buildCodexConfig(BASE, "provider").installBash).toContain("set -euo pipefail");
  });

  it("persists the env var in provider mode and skips auth.json", () => {
    const bundle = buildCodexConfig(BASE, "provider");
    expect(bundle.installBash).toContain("export CODEX_GATEWAY_API_KEY=");
    expect(bundle.installBash).not.toContain("auth.json");
  });

  it("quotes a key containing a single quote safely", () => {
    const tricky = "sk-cgw-a'b";
    expect(shellSingleQuote(tricky)).toBe(`'sk-cgw-a'\\''b'`);
    const bundle = buildCodexConfig({ ...BASE, apiKey: tricky }, "provider");
    expect(bundle.installBash).toContain(`'sk-cgw-a'\\''b'`);
  });

  it("restricts permissions on files holding the key", () => {
    expect(buildCodexConfig(BASE, "openai").installBash).toContain('chmod 600 "$CODEX_HOME/auth.json"');
  });
});

describe("manual steps", () => {
  it("ends with a verification step in both modes", () => {
    for (const mode of ["provider", "openai"] as const) {
      const bundle = buildCodexConfig(BASE, mode);
      const steps = codexManualSteps(bundle, "CODEX_GATEWAY_API_KEY");
      expect(steps.at(-1)?.body).toContain("codex");
    }
  });

  it("shows auth.json only in openai mode", () => {
    const providerSteps = codexManualSteps(buildCodexConfig(BASE, "provider"), "CODEX_GATEWAY_API_KEY");
    const openaiSteps = codexManualSteps(buildCodexConfig(BASE, "openai"), "CODEX_GATEWAY_API_KEY");
    expect(providerSteps.some((step) => step.title.includes("auth.json"))).toBe(false);
    expect(openaiSteps.some((step) => step.title.includes("auth.json"))).toBe(true);
  });
});
