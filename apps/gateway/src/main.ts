import { env } from "./env.js";
import { buildServer, ensureBootstrapAdmin } from "./server.js";
import { startBackgroundJobs } from "./jobs.js";

async function main(): Promise<void> {
  const config = env();
  const app = await buildServer(config);

  await ensureBootstrapAdmin(config, app.log);
  const stopJobs = startBackgroundJobs(app);

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    { port: config.PORT, publicUrl: config.PUBLIC_GATEWAY_URL },
    "Codex Gateway is accepting requests"
  );

  // Let in-flight streams finish before the process exits.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    stopJobs();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Gateway failed to start:", error);
  process.exit(1);
});
