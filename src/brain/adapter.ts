import { think } from "@axis/brain";
import type {
  Intent as BrainIntent,
  UserContext as BrainUserContext,
  Thought,
  OrderSummary,
} from "@axis/brain";
import type { RecognizedIntent } from "../recognition/types.js";
import type {
  SessionState,
  OutboundMessage,
  ConversationEvent,
} from "../core/types.js";
function toBrainIntent(r: RecognizedIntent): BrainIntent {
  return {
    action: r.action,
    vendor: r.vendor,
    item: r.item,
    quantity: r.quantity,
    confidence: r.confidence,
    clarificationNeeded: r.clarificationNeeded,
    clarificationPrompt: r.clarificationPrompt,
  };
}
function toBrainUserContext(
  session: SessionState | null,
  userId: string,
  history: ConversationEvent[],
): BrainUserContext {
  const inbound = history.filter((e) => e.direction === "in");
  const previousUserText =
    inbound.length >= 2 ? inbound[inbound.length - 2].text : undefined;
  const recentOrders: OrderSummary[] = [];
  const lastOrder = session?.context?.lastOrder as
    | {
        item: string;
        vendor: string;
        when: number;
      }
    | undefined;
  if (lastOrder) recentOrders.push(lastOrder);
  return {
    userId,
    name: (session?.context?.userName as string | undefined) ?? undefined,
    savedAddresses: (session?.savedLocations ?? [])
      .map((l) => l.label ?? l.address ?? "")
      .filter(Boolean),
    recentOrders,
    activeVertical: session?.vertical,
    activeStep: session?.step,
    previousUserText,
    turnCount: inbound.length,
  };
}
function toOutbound(thought: Thought): OutboundMessage[] {
  if (thought.buttons && thought.buttons.length > 0) {
    return [
      {
        kind: "buttons",
        text: thought.say,
        buttons: thought.buttons.map((b) => ({ id: b.id, title: b.title })),
      },
    ];
  }
  if (thought.directive.kind === "request_location") {
    return [{ kind: "location_request", text: thought.say }];
  }
  return [{ kind: "text", text: thought.say }];
}

export interface BrainResult {
  replies: OutboundMessage[];
  directive: Thought["directive"];
  confidence: number;
  reasoning: string;
  revised: boolean;
}

export async function consultBrain(params: {
  recognized: RecognizedIntent;
  session: SessionState | null;
  userId: string;
  rawText: string;
  history: ConversationEvent[];
}): Promise<BrainResult> {
  const thought = await think({
    intent: toBrainIntent(params.recognized),
    user: toBrainUserContext(params.session, params.userId, params.history),
    rawText: params.rawText,
  });
  return {
    replies: toOutbound(thought),
    directive: thought.directive,
    confidence: thought.confidence,
    reasoning: thought.reasoning,
    revised: thought.revised,
  };
}
