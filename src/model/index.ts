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
import { getConfig } from "../core/config.js";

export function createModelProvider(): ModelProvider {
  const cfg = getConfig();
  return new GeminiProvider({
    apiKey: cfg.GEMINI_API_KEY ?? "",
    defaultModelId: cfg.GEMINI_MODEL,
    timeoutMs: cfg.GEMINI_TIMEOUT_MS,
    maxRetries: cfg.GEMINI_MAX_RETRIES,
  });
}

export const modelProvider: ModelProvider = createModelProvider();

export { GeminiProvider } from "./gemini.js";
export type { GeminiOptions } from "./gemini.js";

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
