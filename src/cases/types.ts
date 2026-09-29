/**
 * Case domain primitives (brief §CORE MODEL). A Case is the durable
 * representation of work; a Playbook drives it through named states; Actions are
 * the side-effectful steps (each exactly-once by idempotency key); every
 * financial action carries a Reservation; ProviderAttempts record what actually
 * happened on the wire; Evidence is what completion must be proven with.
 */

export type CaseStatus =
  | "prepared"
  | "verifying"
  | "running" // a state handler is logically executing / ready to advance
  | "waiting_user" // a Decision is open; resumes on signal()
  | "waiting_timeout" // parked until wake_at; the worker resumes it
  | "in_doubt" // a provider outcome is unknown; reconciler owns it
  | "completed"
  | "failed"
  | "cancelled";

export interface CaseRecord {
  id: string;
  userId: string;
  channel: string;
  goal: string;
  playbook: string;
  /** Current playbook state name (the resume point). */
  state: string;
  status: CaseStatus;
  context: Record<string, unknown>;
  /** Case spend ceiling in minor units (kobo for NGN). */
  budgetMinor: bigint | null;
  deadlineAt: Date | null;
  /** When waiting_timeout, when the worker should resume. */
  wakeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseEvent {
  caseId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: Date;
}

export type ActionStatus =
  | "proposed"
  | "authorized" // policy said yes
  | "rejected" // policy said no (result carries the reason)
  | "executing"
  | "in_doubt"
  | "settled"
  | "released"
  | "failed"
  | "reversed";

export interface ActionRecord {
  id: string;
  caseId: string;
  capability: string;
  status: ActionStatus;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  /** Stable across retries — the exactly-once boundary. */
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export type AttemptOutcome = "ok" | "failed" | "unknown" | "submitted";

/** Execution mode of the provider that served an attempt. Mocks must never be
 *  reachable from a production deployment — the mode is persisted on every
 *  attempt so an audit can prove what served the work. */
export type ExecutionMode = "LIVE" | "SANDBOX" | "MOCK" | "HANDOFF" | "UPSTREAM_MCP" | "UNAVAILABLE";

export interface ProviderAttempt {
  id: string;
  actionId: string;
  seq: number;
  provider: string;
  mode: ExecutionMode;
  request: Record<string, unknown>;
  outcome: AttemptOutcome;
  response: Record<string, unknown> | null;
  providerRef: string | null;
  error: string | null;
  at: Date;
}

export type ReservationStatus = "reserved" | "captured" | "released" | "in_doubt" | "reversed";

export interface Reservation {
  id: string;
  actionId: string;
  owner: string;
  amountMinor: bigint;
  asset: string;
  status: ReservationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type EvidenceKind =
  | "verification"
  | "provider_receipt"
  | "ledger_settlement"
  | "merchant_confirmation"
  | "delivery_event"
  | "authenticated_participant_reply"
  | "external_state"
  | "user_confirmation";

export interface Evidence {
  id: string;
  caseId: string;
  actionId: string | null;
  kind: EvidenceKind;
  payload: Record<string, unknown>;
  at: Date;
}

export interface Decision {
  id: string;
  caseId: string;
  question: string;
  options: string[];
  status: "open" | "answered" | "expired";
  answer: string | null;
  answeredAt: Date | null;
  createdAt: Date;
}

/** What a state handler tells the runtime to do next. Exactly one branch. */
export type Transition =
  | { to: string; context?: Record<string, unknown> } // advance, keep running
  | { askUser: { question: string; options?: string[] }; context?: Record<string, unknown> }
  | { sleepUntil: Date; to?: string; context?: Record<string, unknown> }
  | { inDoubt: { reason: string }; context?: Record<string, unknown> }
  | { complete: { summary: string }; context?: Record<string, unknown> }
  | { fail: { reason: string }; context?: Record<string, unknown> };

/** Messages a state handler can emit for the channel (replies, prompts). */
export interface CaseMessage {
  kind: "text";
  text: string;
}

/** A playbook is a named state machine over CaseContext. Handlers are pure
 *  orchestration: they call capabilities/policy/money and return a Transition.
 *  The runtime persists state + events between handlers, so a crash anywhere
 *  resumes from the recorded state. */
export interface CaseContext {
  caseId: string;
  userId: string;
  channel: string;
  goal: string;
  state: string;
  context: Record<string, unknown>;
  /** Reply the channel should show for this step (cleared on resume). */
  pendingReplies: CaseMessage[];
}

export interface PlaybookState {
  onEnter(ctx: CaseContext): Promise<Transition>;
}

export interface Playbook {
  id: string;
  initialState: string;
  verification?: "read" | "write" | "financial" | "external_commitment";
  states: Record<string, PlaybookState>;
}
