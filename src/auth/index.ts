/**
 * Process-wide AuthService. Enabled when DATABASE_URL is set (email/password
 * accounts need durable storage); otherwise auth is disabled and the routes 503.
 */
import { getConfig } from "../core/config.js";
import { AuthService } from "./auth.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("auth");
let service: AuthService | null = null;

export function getAuth(): AuthService | null {
  return service;
}

export async function initAuth(): Promise<void> {
  const url = getConfig().DATABASE_URL;
  if (!url) {
    log.info("Auth: disabled (set DATABASE_URL for email/password accounts).");
    return;
  }
  const svc = new AuthService(url);
  try {
    await svc.init();
    service = svc;
    log.info("Auth: Postgres ready.");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Auth init failed; email/password disabled");
  }
}
