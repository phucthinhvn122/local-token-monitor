import { safeError } from "@ltm/core";
import { startServer } from "./index.ts";

startServer().catch((error) => {
  console.error(`Local Token Monitor failed to start: ${safeError(error)}`);
  process.exitCode = 1;
});
