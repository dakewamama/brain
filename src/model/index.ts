/**
 * Public surface of the model provider layer.
 *
 * This task ships the interface and typed errors only — no provider is
 * instantiated here yet. The Gemini implementation (next step) will add a
 * `gemini.ts` and a selector that returns a `ModelProvider` from config, exactly
 * like `providers/index.ts` and `recognition/index.ts` do for their layers.
 */
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
