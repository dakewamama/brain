import { createServer } from "./server.js";
import { logger } from "./core/logger.js";
import { initMemory } from "./memory/index.js";
import { initAuth } from "./auth/index.js";
import { skills } from "./skills/index.js";
import { parseMcpServers, registerMcpTools } from "./mcp/bootstrap.js";
import { initCases, startCaseWorker } from "./cases/index.js";

const { app, cfg, adapters } = createServer();
// Best-effort: wire up durable memory if a DB is configured (falls back quietly).
void initMemory();
// Best-effort: email/password accounts (needs DATABASE_URL).
void initAuth();
// Case runtime: Postgres-backed when DATABASE_URL is set. The worker moves
// waiting cases (rechecks, deadlines) and delivers reconciled verdicts through
// the channel adapters.
void initCases(async (userId, channel, texts) => {
  try {
    if (channel === "whatsapp") await adapters.whatsapp.send(userId, texts.map((t) => ({ kind: "text" as const, text: t })));
    else if (channel === "telegram") await adapters.telegram.send(userId, texts.map((t) => ({ kind: "text" as const, text: t })));
    // web/console cases surface through /admin/cases; the browser sees case
    // state via the pipeline's synchronous replies.
  } catch (err) {
    logger.warn({ err: String(err) }, "case notification delivery failed; worker will retry");
  }
}).then(() => {
  startCaseWorker();
});
// Best-effort: auto-register configured MCP servers' tools as skills.
void registerMcpTools(skills, parseMcpServers(cfg.MCP_SERVERS)).then((n) => {
  if (n > 0) logger.info(`Registered ${n} MCP tools as skills.`);
});
app.listen(cfg.PORT, () => {
  logger.info(`Axis listening on :${cfg.PORT} (${cfg.NODE_ENV})`);
});
