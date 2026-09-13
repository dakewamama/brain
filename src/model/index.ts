/**
 * Public surface of the model provider layer.
 *
 * `modelProvider` is the process-wide provider, selected from config exactly like
 * `providers/index.ts` and `recognition/index.ts`. Today that is Gemini. Adding a
 * second provider means implementing `ModelProvider` and switching here — callers
 * never change. There is no rules/string fallback in this layer: a missing key or
 * a bad response surfaces as a typed error (the recognizer keeps its own separate
 * rules fallback).
 */
import type { ModelProvider } from "./types.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatProvider } from "./openai.js";
import { FallbackProvider } from "./fallback.js";
import { getConfig, type Config } from "../core/config.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("model");

function buildOne(id: string, cfg: Config): ModelProvider {
  if (id === "openai") {
    return new OpenAICompatProvider({
      apiKey: cfg.OPENAI_API_KEY ?? "",
      baseUrl: cfg.OPENAI_BASE_URL,
      defaultModelId: cfg.OPENAI_MODEL,
      timeoutMs: cfg.GEMINI_TIMEOUT_MS,
      maxRetries: cfg.GEMINI_MAX_RETRIES,
    });
  }
  return new GeminiProvider({
    apiKey: cfg.GEMINI_API_KEY ?? "",
    defaultModelId: cfg.GEMINI_MODEL,
    timeoutMs: cfg.GEMINI_TIMEOUT_MS,
    maxRetries: cfg.GEMINI_MAX_RETRIES,
  });
}

export function createModelProvider(): ModelProvider {
  const cfg = getConfig();
  const spec = cfg.MODEL_PROVIDER ?? (cfg.OPENAI_API_KEY ? "openai" : "gemini");
  const ids = spec
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "openai" || s === "gemini");
  const order = ids.length ? ids : ["gemini"];
  log.info(`Model provider chain: ${order.join(" -> ")}.`);
  const providers = order.map((id) => buildOne(id, cfg));
  return providers.length > 1 ? new FallbackProvider(providers) : providers[0];
}

export const modelProvider: ModelProvider = createModelProvider();

export { GeminiProvider } from "./gemini.js";
export type { GeminiOptions } from "./gemini.js";
export { OpenAICompatProvider } from "./openai.js";
export type { OpenAIOptions } from "./openai.js";
export { FallbackProvider } from "./fallback.js";

export type {
  JsonSchema,
  ModelRole,
  ModelMessage,
  ToolDefinition,
  ToolInvocation,
  ToolChoice,
  GenerateOptions,
  TokenUsage,
  FinishReason,
  GenerateResult,
  ModelProvider,
} from "./types.js";

export {
  ModelError,
  ModelTimeoutError,
  ModelTransportError,
  ModelRefusalError,
  ModelSchemaError,
  isModelError,
} from "./errors.js";
export type { ModelErrorKind, ModelErrorContext } from "./errors.js";
