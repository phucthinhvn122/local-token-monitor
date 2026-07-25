import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../apps/server/src/index.js";

describe("Quota Internal APIs Integration", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    process.env.LTM_DEMO_MODE = "true";
    server = await startServer({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (server) {
      await server.app.close();
    }
  });

  it("GET /api/health returns ok", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/health"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("GET /api/quota returns valid QuotaStatus object", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/quota"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.provider).toBe("nxtcodex");
    expect(body.status).toBeDefined();
    expect(body.checkedAt).toBeDefined();
  });

  it("POST /api/quota/refresh triggers refresh and saves snapshot", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/quota/refresh"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.provider).toBe("nxtcodex");
    expect(body.checkedAt).toBeDefined();
  });

  it("GET /api/quota/history returns history array and consumption stats", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/quota/history?limit=10"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.provider).toBe("nxtcodex");
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.stats).toBeDefined();
    expect(body.stats.avgRatePerMinute).toBeDefined();
  });

  it("GET /api/settings and PUT /api/settings work properly", async () => {
    const getRes = await server.app.inject({
      method: "GET",
      url: "/api/settings"
    });
    expect(getRes.statusCode).toBe(200);

    const patchRes = await server.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        pollingIntervalMs: 60000
      }
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = JSON.parse(patchRes.payload);
    expect(updated.pollingIntervalMs).toBe(60000);
  });
});
