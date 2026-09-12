/**
 * Provider-agnostic model interface.
 *
 * Nothing in this file names a vendor or imports an SDK type. A second provider
 * (OpenAI, Anthropic, a local model) must be addable by implementing
 * `ModelProvider` alone — no caller changes, no shape changes here.
 *
 * HARD BOUNDARY (see TASK): the model INTERPRETS, it does not EXECUTE. Nothing
 * returned from `generate` is a user-facing fact or an outbound-call argument
 * until deterministic code has validated/derived it. This interface deliberately
 * returns prose + structured *requests* (tool invocations), never authority to
 * act. Prices, fares, fees, totals, ETAs, balances and stock come from data
 * sources or computation, never from `GenerateResult.text`.
 */

/** A JSON-Schema (draft-07 subset) object. Kept as an opaque map so this file
 *  takes no dependency on a schema/validation library. */
export type JsonSchema = Record<string, unknown>;

/** Neutral role set. Adapters map these to vendor shapes (e.g. Gemini uses
 *  "model" for assistant turns and a separate systemInstruction). */
export type ModelRole = "system" | "user" | "assistant";

export interface ModelMessage {
  role: ModelRole;
  /** Plain text. Numbers, currency, merchant names, addresses and phone numbers
   *  inside content are opaque to the model and must pass through unchanged. */
  content: string;
}

/**
 * Tool-call seam. Declared here so the NEXT task can populate tools without
 * reopening this interface. No tools are implemented in this task.
 *
 * A tool is DECLARED via `GenerateOptions.tools` and the model may respond with
 * one or more `ToolInvocation`s in `GenerateResult.toolCalls` — a structured
 * request to run a tool, never the tool's result and never a side effect. The
 * caller decides whether/how to execute; execution is deterministic code.
 */
export interface ToolDefinition {
  /** Stable identifier the model uses to request this tool. */
  name: string;
  /** Natural-language description the model uses to decide when to call it. */
  description: string;
  /** JSON-Schema for the tool's arguments. */
  parameters: JsonSchema;
}

export interface ToolInvocation {
  /** Correlation id when the provider supplies one (OpenAI does); `undefined`
   *  on providers that don't (Gemini). Callers must not depend on it. */
  id?: string;
  /** The `ToolDefinition.name` the model chose. */
  name: string;
  /** Arguments as an already-parsed object. Providers that return a JSON string
   *  (OpenAI) parse it in the adapter; providers that return an object (Gemini)
   *  pass it through. Arguments are UNTRUSTED input to be validated by the tool
   *  layer, never passed to an outbound call as-is. */
  arguments: Record<string, unknown>;
}

/** How the model may use declared tools. */
export type ToolChoice = "auto" | "none" | { name: string };

export interface GenerateOptions {
  /** Override the provider's default model for this call (attribution/cost). */
  modelId?: string;
  /** Per-call timeout; falls back to the provider's default. */
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Convenience system instruction; equivalent to a leading system message. */
  system?: string;
  /** Tools the model may request. Declaring tools does not permit execution. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /**
   * When set, the model is asked to return JSON and the provider validates the
   * parsed output against this schema. A parse or validation failure is a
   * `ModelSchemaError` — never a silent fall-through to string matching. The
   * validated object is returned on `GenerateResult.json`.
   */
  responseSchema?: JsonSchema;
  /** Cooperative cancellation, in addition to `timeoutMs`. */
  signal?: AbortSignal;
}

/** Token accounting in neutral names (adapters map vendor field names). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "other";

export interface GenerateResult {
  /** Model prose. Empty string when the model returned only tool calls. Never a
   *  source of user-facing numeric facts. */
  text: string;
  /** Structured tool requests; empty array when none. */
  toolCalls: ToolInvocation[];
  /** Present only when `responseSchema` was supplied: the parsed + validated
   *  JSON. Typed as `unknown`; the caller narrows it. */
  json?: unknown;
  usage: TokenUsage;
  /** Total wall-clock for the call. */
  latencyMs: number;
  /** Time to first token when streamed; `undefined` for unary calls. */
  timeToFirstTokenMs?: number;
  /** The model that actually served the call — for cost/latency attribution. */
  modelId: string;
  finishReason: FinishReason;
}

export interface ModelProvider {
  /** Provider id, e.g. "gemini". Stable; used in structured logs. */
  readonly id: string;
  /** Default model id used when `GenerateOptions.modelId` is omitted. */
  readonly defaultModelId: string;
  generate(
    messages: ModelMessage[],
    opts?: GenerateOptions,
  ): Promise<GenerateResult>;
}
