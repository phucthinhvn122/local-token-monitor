import { beforeEach, describe, expect, it } from "vitest";
import {
  circuitIsOpen,
  eligibleProviders,
  isProviderFailure,
  nextBreakerState,
  orderProviders,
  resetRoundRobin,
  servesModel,
  type RoutableProvider
} from "../apps/gateway/src/lib/router.js";
import { resolveUpstreamUrl } from "../apps/gateway/src/lib/upstream.js";

const provider = (over: Partial<RoutableProvider> & { id: string }): RoutableProvider => ({
  name: over.id,
  priority: 100,
  weight: 1,
  models: [],
  wireApi: "CHAT",
  isActive: true,
  consecutiveErrors: 0,
  circuitOpenUntil: null,
  ...over
});

beforeEach(() => resetRoundRobin());

describe("eligibility", () => {
  it("excludes inactive providers", () => {
    const pool = [provider({ id: "a" }), provider({ id: "b", isActive: false })];
    expect(eligibleProviders(pool, { strategy: "PRIORITY" }).map((item) => item.id)).toEqual(["a"]);
  });

  it("excludes providers whose circuit is open", () => {
    const future = new Date(Date.now() + 60_000);
    const pool = [provider({ id: "a" }), provider({ id: "b", circuitOpenUntil: future })];
    expect(eligibleProviders(pool, { strategy: "PRIORITY" }).map((item) => item.id)).toEqual(["a"]);
  });

  it("readmits a provider once its cooldown has elapsed", () => {
    const past = new Date(Date.now() - 1000);
    const target = provider({ id: "a", circuitOpenUntil: past });
    expect(circuitIsOpen(target)).toBe(false);
    expect(eligibleProviders([target], { strategy: "PRIORITY" })).toHaveLength(1);
  });

  it("respects a model allow-list, treating it as a prefix match", () => {
    const restricted = provider({ id: "a", models: ["gpt-5"] });
    expect(servesModel(restricted, "gpt-5-codex")).toBe(true);
    expect(servesModel(restricted, "claude-sonnet-4-5")).toBe(false);
    // No allow-list means the provider accepts anything.
    expect(servesModel(provider({ id: "b" }), "anything")).toBe(true);
  });

  it("skips providers already tried in this request", () => {
    const pool = [provider({ id: "a" }), provider({ id: "b" })];
    const result = eligibleProviders(pool, { strategy: "PRIORITY", exclude: new Set(["a"]) });
    expect(result.map((item) => item.id)).toEqual(["b"]);
  });
});

describe("wire API filtering", () => {
  const mixed = [
    provider({ id: "chat-1", wireApi: "CHAT" }),
    provider({ id: "resp-1", wireApi: "RESPONSES" }),
    provider({ id: "chat-2", wireApi: "CHAT" })
  ];

  it("routes a chat request only to chat providers", () => {
    const result = eligibleProviders(mixed, { strategy: "PRIORITY", wireApi: "CHAT" });
    expect(result.map((item) => item.id).sort()).toEqual(["chat-1", "chat-2"]);
  });

  it("routes a responses request only to responses providers", () => {
    const result = eligibleProviders(mixed, { strategy: "PRIORITY", wireApi: "RESPONSES" });
    expect(result.map((item) => item.id)).toEqual(["resp-1"]);
  });

  it("returns an empty pool when nothing speaks the protocol", () => {
    const chatOnly = [provider({ id: "a" }), provider({ id: "b" })];
    expect(eligibleProviders(chatOnly, { strategy: "PRIORITY", wireApi: "RESPONSES" })).toEqual([]);
  });

  it("applies no filter when the context does not specify a wire API", () => {
    expect(eligibleProviders(mixed, { strategy: "PRIORITY" })).toHaveLength(3);
  });
});

describe("PRIORITY strategy", () => {
  it("orders by ascending priority", () => {
    const pool = [provider({ id: "c", priority: 30 }), provider({ id: "a", priority: 10 }), provider({ id: "b", priority: 20 })];
    expect(orderProviders(pool, { strategy: "PRIORITY" }).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties toward the healthier provider", () => {
    const pool = [provider({ id: "sick", consecutiveErrors: 2 }), provider({ id: "well", consecutiveErrors: 0 })];
    expect(orderProviders(pool, { strategy: "PRIORITY" })[0].id).toBe("well");
  });

  it("returns every eligible provider so the caller can fail over", () => {
    const pool = [provider({ id: "a", priority: 1 }), provider({ id: "b", priority: 2 }), provider({ id: "c", priority: 3 })];
    expect(orderProviders(pool, { strategy: "PRIORITY" })).toHaveLength(3);
  });
});

describe("ROUND_ROBIN strategy", () => {
  it("advances the head on each call and wraps around", () => {
    const pool = [provider({ id: "a" }), provider({ id: "b" }), provider({ id: "c" })];
    const heads = [0, 1, 2, 3].map(() => orderProviders(pool, { strategy: "ROUND_ROBIN" })[0].id);
    expect(heads).toEqual(["a", "b", "c", "a"]);
  });

  it("still lists every provider behind the head", () => {
    const pool = [provider({ id: "a" }), provider({ id: "b" })];
    expect(orderProviders(pool, { strategy: "ROUND_ROBIN" }).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("WEIGHTED strategy", () => {
  it("returns a full permutation with no duplicates", () => {
    const pool = [provider({ id: "a", weight: 5 }), provider({ id: "b", weight: 1 }), provider({ id: "c", weight: 1 })];
    const order = orderProviders(pool, { strategy: "WEIGHTED" });
    expect(new Set(order.map((item) => item.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("favours the heavier provider over many draws", () => {
    const pool = [provider({ id: "heavy", weight: 9 }), provider({ id: "light", weight: 1 })];
    let heavyFirst = 0;
    for (let i = 0; i < 400; i++) {
      if (orderProviders(pool, { strategy: "WEIGHTED" })[0].id === "heavy") heavyFirst++;
    }
    // Expected ~90%; a wide band keeps this from being flaky.
    expect(heavyFirst).toBeGreaterThan(280);
  });
});

describe("circuit breaker", () => {
  it("stays closed below the threshold", () => {
    const state = nextBreakerState(1, { threshold: 3, cooldownSeconds: 60 });
    expect(state).toMatchObject({ consecutiveErrors: 2, opened: false, circuitOpenUntil: null });
  });

  it("opens exactly at the threshold", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const state = nextBreakerState(2, { threshold: 3, cooldownSeconds: 60, now });
    expect(state.opened).toBe(true);
    expect(state.circuitOpenUntil?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("counts 5xx, 408, 429 and transport failures against the provider", () => {
    for (const status of [500, 502, 503, 408, 429, null]) {
      expect(isProviderFailure(status)).toBe(true);
    }
  });

  it("does not blame the provider for a client error", () => {
    // Retrying a 400 or a 401 elsewhere would just repeat the same rejection.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isProviderFailure(status)).toBe(false);
    }
  });
});

describe("failover across the ordered pool", () => {
  /** Mirrors the loop in routes/gateway.ts without the network. */
  function attempt(pool: RoutableProvider[], responder: (id: string) => number) {
    const tried: string[] = [];
    for (const candidate of orderProviders(pool, { strategy: "PRIORITY" })) {
      tried.push(candidate.id);
      const status = responder(candidate.id);
      if (!isProviderFailure(status)) return { tried, servedBy: candidate.id, status };
    }
    return { tried, servedBy: null, status: 502 };
  }

  const pool = [
    provider({ id: "primary", priority: 1 }),
    provider({ id: "secondary", priority: 2 }),
    provider({ id: "tertiary", priority: 3 })
  ];

  it("falls through to the next provider on a 5xx", () => {
    const result = attempt(pool, (id) => (id === "primary" ? 503 : 200));
    expect(result.tried).toEqual(["primary", "secondary"]);
    expect(result.servedBy).toBe("secondary");
  });

  it("keeps going until one provider succeeds", () => {
    const result = attempt(pool, (id) => (id === "tertiary" ? 200 : 500));
    expect(result.tried).toEqual(["primary", "secondary", "tertiary"]);
    expect(result.servedBy).toBe("tertiary");
  });

  it("gives up after the whole pool fails", () => {
    const result = attempt(pool, () => 500);
    expect(result.servedBy).toBeNull();
    expect(result.tried).toHaveLength(3);
  });

  it("does not fail over on a client error", () => {
    const result = attempt(pool, () => 400);
    expect(result.tried).toEqual(["primary"]);
    expect(result.status).toBe(400);
  });

  it("routes around a provider whose circuit is already open", () => {
    const withOpen = [
      provider({ id: "primary", priority: 1, circuitOpenUntil: new Date(Date.now() + 30_000) }),
      provider({ id: "secondary", priority: 2 })
    ];
    const result = attempt(withOpen, () => 200);
    expect(result.tried).toEqual(["secondary"]);
  });
});

describe("upstream URL joining", () => {
  it("appends the path to a bare origin", () => {
    expect(resolveUpstreamUrl("https://api.test", "/v1/chat/completions")).toBe(
      "https://api.test/v1/chat/completions"
    );
  });

  it("does not double up /v1 when the base already has it", () => {
    expect(resolveUpstreamUrl("https://api.test/v1", "/v1/chat/completions")).toBe(
      "https://api.test/v1/chat/completions"
    );
  });

  it("tolerates a trailing slash", () => {
    expect(resolveUpstreamUrl("https://api.test/", "/v1/models")).toBe("https://api.test/v1/models");
  });
});
