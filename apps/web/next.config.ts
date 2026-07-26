import type { NextConfig } from "next";

/**
 * The dashboard talks to the gateway through a same-origin `/api/*` rewrite.
 * That keeps the session cookie first-party (no SameSite=None, no CORS
 * preflight on every call) and means the gateway never has to be exposed to the
 * browser directly — in Docker Compose it stays on the internal network.
 */
const gatewayUrl = process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:4000";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@cgw/shared"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${gatewayUrl}/api/:path*` }];
  }
};

export default config;
