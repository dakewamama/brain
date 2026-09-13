/**
 * Gemini implementation of ModelProvider, over the REST API (no SDK, so no SDK
 * types leak past this file).
 *
 * Guarantees required by the task:
 *  - API key from constructor (config→env) only. Never in source, never in a
 *    URL, never logged, never in an error/stack. Sent as the x-goog-api-key
 *    header, not a query param.
 *  - Explicit per-call timeout with a default; overridable per call.
 *  - Retry only on transport (429 / 5xx / network) with capped backoff. Never
 *    retries a landed side effect — generate() has none.
 *  - Structured output: when a responseSchema is given, ask for JSON, parse it,
 *    and validate against the schema. A failure is a typed ModelSchemaError,
 *    never a string-matching fallback.
 *  - Tool declarations map to Gemini functionDeclarations; functionCall parts
 *    map back to provider-agnostic ToolInvocations.
 *
 * It NEVER executes a tool, calls a payment/provider API, or invents a number.
 */
import Ajv, { type ValidateFunction } from "ajv";
import type {
  FinishReason,
  GenerateOptions,
  GenerateResult,
  JsonSchema,
  ModelMessage,
  ModelProvider,
  ToolInvocation,
} from "./types.js";
import {
  ModelRefusalError,
  ModelSchemaError,
  ModelTimeoutError,
  ModelTransportError,
} from "./errors.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("model");
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const SAFETY_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

export interface GeminiOptions {
  /** May be empty; generate() then throws a typed error rather than crashing. */
  apiKey: string;
  defaultModelId: string;
  timeoutMs: number;
  maxRetries: number;
  /** Base backoff in ms (exponential). Small in tests. */
  retryBaseMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export class GeminiProvider implements ModelProvider {
  readonly id = "gemini";
  readonly defaultModelId: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validators = new WeakMap<JsonSchema, ValidateFunction>();

  constructor(opts: GeminiOptions) {
    // Trim defensively: a key pasted with a trailing newline/space would make
    // every request 401 with an otherwise baffling "invalid key".
    this.apiKey = opts.apiKey.trim();
    this.defaultModelId = opts.defaultModelId;
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.retryBaseMs = opts.retryBaseMs ?? 300;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const modelId = opts.modelId ?? this.defaultModelId;

    // Missing key is a deterministic misconfiguration — a clean typed error, not
    // a crash and not a leak (there is no key to leak). Status 401 => not retried.
    if (!this.apiKey) {
      throw new ModelTransportError("GEMINI_API_KEY is not set", {
        provider: this.id,
        modelId,
        status: 401,
      });
    }

    const body = this.buildRequestBody(messages, opts);
    const url = `${BASE_URL}/models/${encodeURIComponent(modelId)}:generateContent`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    const started = Date.now();
    let attempt = 0;
    // Attempt loop: 1 initial + up to maxRetries retries, retryable errors only.
    for (;;) {
      attempt++;
      try {
        const res = await this.fetchOnce(url, body, timeoutMs, modelId, opts.signal);
        const result = await this.mapResponse(res, modelId, opts, started);
        log.info(
          {
            provider: this.id,
            modelId,
            latencyMs: result.latencyMs,
            attempts: attempt,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            finishReason: result.finishReason,
            toolCalls: result.toolCalls.length,
          },
          "model.generate",
        );
        return result;
      } catch (err) {
        const retryable =
          (err instanceof ModelTransportError || err instanceof ModelTimeoutError) &&
          err.retryable;
        if (retryable && attempt <= this.maxRetries) {
          const delay = this.retryBaseMs * 2 ** (attempt - 1);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
  }

  private async fetchOnce(
    url: string,
    body: unknown,
    timeoutMs: number,
    modelId: string,
    external?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    external?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Read a short body for a message, but never echo the key (it isn't in
        // the response) and never the request.
        const detail = await safeErrorDetail(res);
        throw new ModelTransportError(
          `gemini HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
          { provider: this.id, modelId, status: res.status },
        );
      }
      return res;
    } catch (err) {
      if (err instanceof ModelTransportError) throw err;
      if (isAbortError(err)) {
        if (timedOut) {
          throw new ModelTimeoutError(timeoutMs, { provider: this.id, modelId });
        }
        // External cancellation — surface as non-retryable transport (status 0).
        throw new ModelTransportError("request aborted", {
          provider: this.id,
          modelId,
          status: 0,
        });
      }
      // Network-level failure (DNS, reset) — retryable transport, no status.
      throw new ModelTransportError(networkMessage(err), {
        provider: this.id,
        modelId,
      });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }

  private buildRequestBody(
    messages: ModelMessage[],
    opts: GenerateOptions,
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    if (opts.system) systemParts.push(opts.system);
    const contents: Array<{ role: "user" | "model"; parts: { text: string }[] }> =
      [];
    for (const m of messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
        continue;
      }
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }

    const generationConfig: Record<string, unknown> = {};
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
    if (opts.maxOutputTokens !== undefined)
      generationConfig.maxOutputTokens = opts.maxOutputTokens;
    if (opts.responseSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = toGeminiSchema(opts.responseSchema);
    }

    const body: Record<string, unknown> = { contents };
    if (systemParts.length) {
      body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
    }
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    if (opts.tools?.length) {
      body.tools = [
        {
          functionDeclarations: opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.parameters),
          })),
        },
      ];
      const choice = opts.toolChoice;
      if (choice === "none") {
        body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      } else if (choice && typeof choice === "object") {
        body.toolConfig = {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [choice.name],
          },
        };
      } else {
        body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
      }
    }

    return body;
  }

  private async mapResponse(
    res: Response,
    modelId: string,
    opts: GenerateOptions,
    started: number,
  ): Promise<GenerateResult> {
    const data = (await res.json()) as GeminiResponse;
    const latencyMs = Date.now() - started;

    const candidate = data.candidates?.[0];
    const rawFinish = candidate?.finishReason;

    // Blocked prompt or safety stop with nothing usable => refusal.
    if (data.promptFeedback?.blockReason) {
      throw new ModelRefusalError("prompt blocked by provider", {
        provider: this.id,
        modelId,
        reason: data.promptFeedback.blockReason,
      });
    }

    const parts = candidate?.content?.parts ?? [];
    let text = "";
    const toolCalls: ToolInvocation[] = [];
    for (const p of parts) {
      if (typeof p.text === "string") text += p.text;
      if (p.functionCall) {
        toolCalls.push({
          name: p.functionCall.name,
          arguments: (p.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    if (!candidate || (!text && toolCalls.length === 0)) {
      if (rawFinish && SAFETY_REASONS.has(rawFinish)) {
        throw new ModelRefusalError("response withheld by provider", {
          provider: this.id,
          modelId,
          reason: rawFinish,
        });
      }
      throw new ModelTransportError(
        `gemini returned no content (finishReason=${rawFinish ?? "none"})`,
        { provider: this.id, modelId, status: res.status },
      );
    }

    const usage = mapUsage(data.usageMetadata);
    const finishReason: FinishReason =
      toolCalls.length > 0 ? "tool_calls" : mapFinish(rawFinish);

    let json: unknown;
    if (opts.responseSchema) {
      json = this.parseAndValidate(text, opts.responseSchema, modelId);
    }

    return {
      text,
      toolCalls,
      json,
      usage,
      latencyMs,
      modelId,
      finishReason,
    };
  }

  private parseAndValidate(
    text: string,
    schema: JsonSchema,
    modelId: string,
  ): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (err) {
      throw new ModelSchemaError("model output was not valid JSON", {
        provider: this.id,
        modelId,
        cause: err,
        rawSample: text.slice(0, 200),
      });
    }
    let validate = this.validators.get(schema);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.validators.set(schema, validate);
    }
    if (!validate(parsed)) {
      throw new ModelSchemaError("model JSON failed schema validation", {
        provider: this.id,
        modelId,
        issues: validate.errors,
        rawSample: text.slice(0, 200),
      });
    }
    return parsed;
  }
}

// --- Gemini response shape (local, not exported; keeps SDK types out of the API) ---
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

function mapUsage(u: GeminiResponse["usageMetadata"]) {
  return {
    inputTokens: u?.promptTokenCount ?? 0,
    outputTokens: u?.candidatesTokenCount ?? 0,
    totalTokens: u?.totalTokenCount ?? 0,
  };
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case undefined:
      return "stop";
    default:
      return SAFETY_REASONS.has(reason) ? "content_filter" : "other";
  }
}

/** Down-convert a draft-07-ish JSON Schema to Gemini's OpenAPI subset: uppercase
 *  `type`, recurse into properties/items, drop keys Gemini rejects. */
function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    // Drop keys Gemini's OpenAPI subset rejects. `enum`/`format` in particular
    // make the responseSchema 400 on 2.x models; we constrain values with our
    // own client-side validation + prompt instead.
    if (
      k === "$schema" ||
      k === "$ref" ||
      k === "additionalProperties" ||
      k === "enum" ||
      k === "format"
    ) {
      continue;
    }
    if (k === "type" && typeof v === "string") {
      out.type = v.toUpperCase();
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, JsonSchema>).map(([pk, pv]) => [
          pk,
          toGeminiSchema(pv),
        ]),
      );
    } else if (k === "items" && v && typeof v === "object") {
      out.items = toGeminiSchema(v as JsonSchema);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    return body.error?.message ?? body.error?.status ?? "";
  } catch {
    return "";
  }
}

/** Pull a JSON value out of model output that may be wrapped in markdown fences
 *  or surrounded by prose. Structured-output models sometimes ignore the JSON
 *  mime type and fence the payload; this recovers it before parsing. */
export function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (t[0] !== "{" && t[0] !== "[") {
    const start = t.search(/[{[]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start !== -1 && end > start) t = t.slice(start, end + 1);
  }
  return t;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function networkMessage(err: unknown): string {
  // Message only; never include headers/body (no key can appear here anyway).
  return err instanceof Error ? `network error: ${err.message}` : "network error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
