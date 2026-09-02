import type { Recognizer } from "./types.js";
import { RuleRecognizer } from "./rules.js";
import { ModelRecognizer } from "./model.js";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";
const log = childLogger("recognition");
function select(): Recognizer {
  const cfg = getConfig();
  if (cfg.RECOGNITION_BASE_URL && cfg.RECOGNITION_API_KEY) {
    log.info(`Using model recognizer (${cfg.RECOGNITION_MODEL}).`);
    return new ModelRecognizer({
      baseUrl: cfg.RECOGNITION_BASE_URL,
      apiKey: cfg.RECOGNITION_API_KEY,
      model: cfg.RECOGNITION_MODEL,
    });
  }
  log.info("Using rule-based recognizer (no model configured).");
  return new RuleRecognizer();
}

export const recognizer: Recognizer = select();
export type { Recognizer, RecognizedIntent, RecognizeInput } from "./types.js";
export { CONFIDENCE_THRESHOLD } from "./types.js";
