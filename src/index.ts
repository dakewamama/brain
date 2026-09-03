import { createServer } from "./server.js";
import { logger } from "./core/logger.js";
const { app, cfg } = createServer();
app.listen(cfg.PORT, () => {
  logger.info(`Axis listening on :${cfg.PORT} (${cfg.NODE_ENV})`);
});
