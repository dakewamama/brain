import { createServer } from "./server.js";
import { logger } from "./core/logger.js";
import { initMemory } from "./memory/index.js";
import { initAuth } from "./auth/index.js";
import { skills } from "./skills/index.js";
import { parseMcpServers, registerMcpTools } from "./mcp/bootstrap.js";
const { app, cfg } = createServer();
// Best-effort: wire up durable memory if a DB is configured (falls back quietly).
void initMemory();
// Best-effort: email/password accounts (needs DATABASE_URL).
void initAuth();
// Best-effort: auto-register configured MCP servers' tools as skills.
void registerMcpTools(skills, parseMcpServers(cfg.MCP_SERVERS)).then((n) => {
  if (n > 0) logger.info(`Registered ${n} MCP tools as skills.`);
});
app.listen(cfg.PORT, () => {
  logger.info(`Axis listening on :${cfg.PORT} (${cfg.NODE_ENV})`);
});
