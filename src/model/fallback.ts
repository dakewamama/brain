/**
 * Failover across providers. Tries each in order; if one is UNAVAILABLE
 * (transport error like 429/5xx/network, or a timeout) it falls through to the
 * next. Deterministic failures (schema validation, content refusal) are NOT
 * failed over — another model would fail the same way — they surface immediately.
 *
 * This is how "use both" works: e.g. Groq primary, Gemini backup. Callers see a
 * single ModelProvider and never change.
 */
import type {
  GenerateOptions,
  GenerateResult,
  ModelMessage,
  ModelProvider,
} from "./types.js";
import { ModelTimeoutError, ModelTransportError } from "./errors.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("model");

export class FallbackProvider implements ModelProvider {
  readonly id = "fallback";

  constructor(private readonly providers: ModelProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackProvider requires at least one provider");
    }
  }

  get defaultModelId(): string {
    return this.providers[0].defaultModelId;
  }

  async generate(
    messages: ModelMessage[],
    opts?: GenerateOptions,
  ): Promise<GenerateResult> {
    let lastErr: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      const hasNext = i + 1 < this.providers.length;
      try {
        return await p.generate(messages, opts);
      } catch (err) {
        lastErr = err;
        const availabilityFailure =
          err instanceof ModelTransportError || err instanceof ModelTimeoutError;
        log.warn(
          {
            provider: p.id,
            kind: (err as { kind?: string })?.kind,
            status: (err as { status?: number })?.status,
            failingOver: availabilityFailure && hasNext,
          },
          "provider failed",
        );
        // Deterministic failures won't improve on another provider.
        if (!availabilityFailure) throw err;
        // Otherwise try the next provider (or exhaust and rethrow below).
      }
    }
    throw lastErr;
  }
}
