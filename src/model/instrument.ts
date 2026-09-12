/**
 * Instrumentation for model usage. Wraps a provider call to:
 *  - count model calls per conversation (queryable via structured logs),
 *  - record latency (total, and time-to-first-token when the provider reports it),
 *  - tag every line with conversation id and model id.
 *
 * No dashboard — just structured logs you can grep/query by conversationId or
 * modelId. Never logs prompt content (may contain names/phones) or any key.
 */
import type {
  GenerateOptions,
  GenerateResult,
  ModelMessage,
  ModelProvider,
} from "./types.js";
import { isModelError, ModelTransportError } from "./errors.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("model");

const callsByConversation = new Map<string, number>();

export function conversationModelCalls(conversationId: string): number {
  return callsByConversation.get(conversationId) ?? 0;
}

export function resetConversationModelCalls(conversationId: string): void {
  callsByConversation.delete(conversationId);
}

/**
 * Call a provider with per-conversation counting + latency logging. `purpose`
 * distinguishes call sites (e.g. "detect", "localize", "recognize") in the logs.
 */
export async function instrumentedGenerate(
  provider: ModelProvider,
  conversationId: string,
  purpose: string,
  messages: ModelMessage[],
  opts?: GenerateOptions,
): Promise<GenerateResult> {
  const callNo = (callsByConversation.get(conversationId) ?? 0) + 1;
  callsByConversation.set(conversationId, callNo);
  try {
    const result = await provider.generate(messages, opts);
    log.info(
      {
        conversationId,
        purpose,
        modelId: result.modelId,
        latencyMs: result.latencyMs,
        timeToFirstTokenMs: result.timeToFirstTokenMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        finishReason: result.finishReason,
        conversationCallNo: callNo,
      },
      "model.call",
    );
    return result;
  } catch (err) {
    // Status + provider message are NOT secret (the key is only ever in a
    // request header, never in a response body or our error text), and they are
    // essential to diagnose transport failures. Log them; still never the key.
    const fields: Record<string, unknown> = {
      conversationId,
      purpose,
      conversationCallNo: callNo,
    };
    if (err instanceof ModelTransportError) {
      fields.kind = err.kind;
      fields.status = err.status;
      fields.detail = err.message;
    } else if (isModelError(err)) {
      fields.kind = err.kind;
      fields.detail = err.message;
    } else {
      fields.kind = "unknown";
    }
    log.warn(fields, "model.call.error");
    throw err;
  }
}
