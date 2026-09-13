/**
 * Typed model errors. Callers switch on `kind`; the retry policy reads
 * `retryable`. None of these carry an API key — messages and fields must never
 * include a credential (enforced by the provider implementation).
 *
 * Retry policy rationale: `generate` has no external side effect (it does not
 * touch payments or provider APIs — that is deterministic code downstream), so a
 * timeout or a transport blip is safe to retry. The "never retry a call whose
 * side effect may already have landed" rule therefore applies to TOOL EXECUTION,
 * not to `generate`. Refusals and schema failures are deterministic and are not
 * retried.
 */

export type ModelErrorKind =
  | "timeout"
  | "refusal"
  | "transport"
  | "schema_validation";

export interface ModelErrorContext {
  provider: string;
  modelId: string;
  cause?: unknown;
}

export abstract class ModelError extends Error {
  abstract readonly kind: ModelErrorKind;
  /** Whether a retry is both safe and potentially useful. */
  abstract readonly retryable: boolean;
  readonly provider: string;
  readonly modelId: string;

  constructor(message: string, ctx: ModelErrorContext) {
    super(message, ctx.cause !== undefined ? { cause: ctx.cause } : undefined);
    this.name = new.target.name;
    this.provider = ctx.provider;
    this.modelId = ctx.modelId;
  }
}

export class ModelTimeoutError extends ModelError {
  readonly kind = "timeout" as const;
  readonly retryable = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, ctx: ModelErrorContext) {
    super(`model call timed out after ${timeoutMs}ms`, ctx);
    this.timeoutMs = timeoutMs;
  }
}

export class ModelTransportError extends ModelError {
  readonly kind = "transport" as const;
  readonly retryable: boolean;
  /** HTTP status when the failure was an HTTP response; `undefined` for
   *  network-level failures (DNS, reset) before a response. */
  readonly status?: number;

  constructor(
    message: string,
    ctx: ModelErrorContext & { status?: number },
  ) {
    super(message, ctx);
    this.status = ctx.status;
    // Retry on 5xx and network-level failures (no status) only. 429 is NOT
    // retried: against a per-minute quota an immediate retry just burns more of
    // it (and adds latency to a chat reply); we fail fast to the caller's safe
    // fallback instead. Other 4xx (bad request, auth) are deterministic.
    this.retryable =
      ctx.status === undefined || (ctx.status >= 500 && ctx.status <= 599);
  }
}

export class ModelRefusalError extends ModelError {
  readonly kind = "refusal" as const;
  readonly retryable = false;
  /** Provider-reported reason (e.g. a safety/content-filter finish reason). */
  readonly reason?: string;

  constructor(
    message: string,
    ctx: ModelErrorContext & { reason?: string },
  ) {
    super(message, ctx);
    this.reason = ctx.reason;
  }
}

export class ModelSchemaError extends ModelError {
  readonly kind = "schema_validation" as const;
  readonly retryable = false;
  /** Validator issues (structure only) — never the raw credential. */
  readonly issues?: unknown;
  /** Truncated sample of the offending output for debugging; contains no secret. */
  readonly rawSample?: string;

  constructor(
    message: string,
    ctx: ModelErrorContext & { issues?: unknown; rawSample?: string },
  ) {
    super(message, ctx);
    this.issues = ctx.issues;
    this.rawSample = ctx.rawSample;
  }
}

export function isModelError(err: unknown): err is ModelError {
  return err instanceof ModelError;
}
