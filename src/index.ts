import { createServer } from "./server.js";
import { logger } from "./core/logger.js";
import { initMemory } from "./memory/index.js";
const { app, cfg } = createServer();
// Best-effort: wire up durable memory if a DB is configured (falls back quietly).
void initMemory();
app.listen(cfg.PORT, () => {
  logger.info(`Axis listening on :${cfg.PORT} (${cfg.NODE_ENV})`);
});
