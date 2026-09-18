/**
 * OpenAI-compatible ModelProvider. Works with any /chat/completions endpoint:
 * Groq (free, fast), OpenRouter (free `:free` models), Together, a local server,
 * or OpenAI itself. Proves the abstraction: a second provider, zero caller
 * changes. Same guarantees as the Gemini provider — env-only key, timeout,
 * capped retries (429 not retried), schema-validated JSON, typed errors.
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
import { extractJson } from "./gemini.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("model");

export interface OpenAIOptions {
  apiKey: string;
  baseUrl: string; // e.g. https://api.groq.com/openai/v1
  defaultModelId: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs?: number;
  fetchFn?: typeof fetch;
}

export class OpenAICompatProvider implements ModelProvider {
  readonly id = "openai";
  readonly defaultModelId: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validators = new WeakMap<JsonSchema, ValidateFunction>();

  constructor(opts: OpenAIOptions) {
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
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
    if (!this.apiKey) {
      throw new ModelTransportError("OPENAI_API_KEY is not set", {
        provider: this.id,
        modelId,
        status: 401,
      });
    }

    const body = this.buildBody(messages, opts, modelId);
    const url = `${this.baseUrl}/chat/completions`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const started = Date.now();

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await this.fetchOnce(url, body, timeoutMs, modelId, opts.signal);
        const result = this.mapResponse(res.data, modelId, opts, Date.now() - started);
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
          await sleep(this.retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
  }

  private buildBody(
    messages: ModelMessage[],
    opts: GenerateOptions,
    modelId: string,
  ): Record<string, unknown> {
    const msgs: Array<{ role: string; content: string }> = [];
    if (opts.system) msgs.push({ role: "system", content: opts.system });
    for (const m of messages) msgs.push({ role: m.role, content: m.content });

    const body: Record<string, unknown> = { model: modelId, messages: msgs };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxOutputTokens !== undefined) body.max_tokens = opts.maxOutputTokens;
    // Broadly-supported JSON mode. Groq (and some others) reject json_object unless
    // the literal word "json" appears in the messages, so guarantee it.
    if (opts.responseSchema) {
      body.response_format = { type: "json_object" };
      if (!msgs.some((m) => /json/i.test(m.content))) {
        if (msgs[0]?.role === "system") {
          msgs[0].content += "\nRespond with a single JSON object.";
        } else {
          msgs.unshift({ role: "system", content: "Respond with a single JSON object." });
        }
      }
    }
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      const choice = opts.toolChoice;
      if (choice === "none") body.tool_choice = "none";
      else if (choice && typeof choice === "object")
        body.tool_choice = { type: "function", function: { name: choice.name } };
      else body.tool_choice = "auto";
    }
    return body;
  }

  private async fetchOnce(
    url: string,
    body: unknown,
    timeoutMs: number,
    modelId: string,
    external?: AbortSignal,
  ): Promise<{ data: OpenAIResponse }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    external?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await safeDetail(res);
        throw new ModelTransportError(
          `openai HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
          { provider: this.id, modelId, status: res.status },
        );
      }
      return { data: (await res.json()) as OpenAIResponse };
    } catch (err) {
      if (err instanceof ModelTransportError) throw err;
      if (isAbortError(err)) {
        if (timedOut) throw new ModelTimeoutError(timeoutMs, { provider: this.id, modelId });
        throw new ModelTransportError("request aborted", {
          provider: this.id,
          modelId,
          status: 0,
        });
      }
      throw new ModelTransportError(
        err instanceof Error ? `network error: ${err.message}` : "network error",
        { provider: this.id, modelId },
      );
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    }
  }

  private mapResponse(
    data: OpenAIResponse,
    modelId: string,
    opts: GenerateOptions,
    latencyMs: number,
  ): GenerateResult {
    const choice = data.choices?.[0];
    const message = choice?.message;
    let text = message?.content ?? "";
    const toolCalls: ToolInvocation[] = [];
    for (const tc of message?.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function?.name ?? "", arguments: args });
    }

    if (!choice || (!text && toolCalls.length === 0)) {
      if (choice?.finish_reason === "content_filter") {
        throw new ModelRefusalError("response withheld by provider", {
          provider: this.id,
          modelId,
          reason: choice.finish_reason,
        });
      }
      throw new ModelTransportError(
        `openai returned no content (finishReason=${choice?.finish_reason ?? "none"})`,
        { provider: this.id, modelId, status: 200 },
      );
    }

    let json: unknown;
    if (opts.responseSchema) json = this.parseAndValidate(text, opts.responseSchema, modelId);

    return {
      text,
      toolCalls,
      json,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      latencyMs,
      modelId,
      finishReason: mapFinish(choice.finish_reason, toolCalls.length),
    };
  }

  private parseAndValidate(text: string, schema: JsonSchema, modelId: string): unknown {
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

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function mapFinish(reason: string | undefined, toolCalls: number): FinishReason {
  if (toolCalls > 0) return "tool_calls";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

async function safeDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? "";
  } catch {
    return "";
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
