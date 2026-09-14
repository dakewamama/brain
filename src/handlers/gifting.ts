import type {
  InboundMessage,
  SessionState,
  HandlerResult,
} from "../core/types.js";
import type { VerticalHandler } from "./types.js";
import { text } from "./types.js";
import { getMemory } from "../memory/index.js";
import { childLogger } from "../core/logger.js";
const log = childLogger("gifting");
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
  private async onRecipient(msg: InboundMessage): Promise<HandlerResult> {
    const phone = extractPhone(msg.text);
    const name = msg.text.replace(/[\d+\s]{7,}/, "").trim() || "your friend";

    // Memory: if there's no number but we already know this person, use the saved
    // one instead of asking again.
    if (!phone) {
      const known = await this.recall(msg.userId, name);
      if (known) {
        return this.gotRecipient(known.name, known.phone);
      }
      return text(
        'I need their WhatsApp number too. Send it like "Ebele 08031234567".',
      );
    }

    // Save the person so next time "send to <name>" just works.
    await this.remember(msg.userId, name, phone);
    return this.gotRecipient(name, phone);
  }

  private gotRecipient(name: string, phone: string): HandlerResult {
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

  private async recall(
    userId: string,
    query: string,
  ): Promise<{ name: string; phone: string } | null> {
    try {
      const r = await getMemory().resolveEntity(userId, "person", query);
      const phone = r.match?.metadata.phone;
      if (r.match && typeof phone === "string") {
        return { name: r.match.canonicalName, phone };
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "memory recall failed");
    }
    return null;
  }

  private async remember(
    userId: string,
    name: string,
    phone: string,
  ): Promise<void> {
    if (!name || name === "your friend") return;
    try {
      await getMemory().upsertEntity({
        userId,
        kind: "person",
        canonicalName: name,
        metadata: { phone },
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "memory save failed");
    }
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
