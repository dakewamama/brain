import type {
  InboundMessage,
  SessionState,
  HandlerResult,
} from "../core/types.js";
import type { VerticalHandler } from "./types.js";
import { text } from "./types.js";
interface GiftContext {
  recipientName?: string;
  recipientPhone?: string;
  itemName?: string;
}

export class GiftingHandler implements VerticalHandler {
  readonly vertical = "gifting" as const;
  async start(
    _msg: InboundMessage,
    _session: SessionState,
  ): Promise<HandlerResult> {
    return {
      replies: [
        {
          kind: "text",
          text: 'Lovely. Who are you sending to? Share their name and WhatsApp number (e.g. "Ebele 0803...").',
        },
      ],
      sessionPatch: {
        vertical: "gifting",
        step: "awaiting_recipient",
        context: {},
      },
    };
  }
  async handle(
    msg: InboundMessage,
    session: SessionState,
  ): Promise<HandlerResult> {
    const ctx = session.context as GiftContext;
    switch (session.step) {
      case "awaiting_recipient":
        return this.onRecipient(msg);
      case "awaiting_item":
        return this.onItem(msg, ctx);
      default:
        return this.start(msg, session);
    }
  }
  private onRecipient(msg: InboundMessage): HandlerResult {
    const phone = extractPhone(msg.text);
    const name = msg.text.replace(/[\d+\s]{7,}/, "").trim() || "your friend";
    if (!phone) {
      return text(
        'I need their WhatsApp number too. Send it like "Ebele 08031234567".',
      );
    }
    return {
      replies: [
        {
          kind: "text",
          text: `Great, a gift for ${name}. What would you like to send them? (e.g. \"chicken wings from Nadia\")`,
        },
      ],
      sessionPatch: {
        step: "awaiting_item",
        context: { recipientName: name, recipientPhone: phone },
      },
    };
  }
  private onItem(msg: InboundMessage, ctx: GiftContext): HandlerResult {
    return {
      replies: [
        {
          kind: "text",
          text:
            `Got it, ${msg.text.trim()} for ${ctx.recipientName ?? "your friend"}.\n` +
            `Next I'll quote delivery to their location and send them a WhatsApp when it's on the way. ` +
            `(This is where gifting plugs into the delivery flow.)`,
        },
      ],
      sessionPatch: { step: "idle", vertical: "unknown", context: {} },
    };
  }
}
function extractPhone(text: string): string | null {
  const m = text.match(/(\+?234|0)\d{9,10}/);
  return m ? m[0] : null;
}
