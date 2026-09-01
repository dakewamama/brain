import pino from "pino";
import { getConfig } from "./config.js";
const config = getConfig();

export const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export function childLogger(scope: string) {
  return logger.child({ scope });
}
