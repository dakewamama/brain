import type { InboundMessage, OutboundMessage } from "../core/types.js";
import type { ChannelAdapter, ParsedInbound } from "./types.js";
import { childLogger } from "../core/logger.js";
import { buttonIdToText } from "../router/buttons.js";
const log = childLogger("web");

const MAX_USER_ID = 64;
const MAX_TEXT = 512;

export class WebInboundError extends Error {}

/**
 * Browser-facing channel. Unlike WhatsApp/Telegram (async push), the web channel
 * is request/response: the caller POSTs one turn and gets the replies back in the
 * same HTTP response, so `send` is a no-op. Inbound is untrusted user input from a
 * public origin, so it is validated and capped before it reaches the pipeline.
 */
export class WebAdapter implements ChannelAdapter {
  readonly id = "web";
  readonly live = true;

  parseInbound(body: unknown): ParsedInbound {
    const b = (body ?? {}) as Record<string, unknown>;

    const userId = typeof b.userId === "string" ? b.userId.trim() : "";
    if (!userId) throw new WebInboundError("userId is required");
    if (userId.length > MAX_USER_ID) {
      throw new WebInboundError(`userId exceeds ${MAX_USER_ID} chars`);
    }

    // A button tap arrives as buttonId; map it to its text like the other channels.
    const buttonId = typeof b.buttonId === "string" ? b.buttonId : undefined;
    const rawText =
      buttonId !== undefined
        ? buttonIdToText(buttonId)
        : typeof b.text === "string"
          ? b.text
          : "";
    const text = rawText.trim();
    const location =
      b.location && typeof b.location === "object" ? b.location : undefined;

    if (!text && !location) {
      throw new WebInboundError("text is required");
    }
    if (text.length > MAX_TEXT) {
      throw new WebInboundError(`text exceeds ${MAX_TEXT} chars`);
    }

    const userName =
      typeof b.userName === "string" ? b.userName.slice(0, MAX_USER_ID) : undefined;

    const message: InboundMessage = {
      channel: "web",
      userId,
      userName,
      text,
      data: {
        ...(buttonId ? { buttonId } : {}),
        ...(location ? { location } : {}),
      },
      timestamp: Date.now(),
    };
    return { messages: [message] };
  }

  // Web replies are returned in the HTTP response, not pushed to the user.
  async send(userId: string, messages: OutboundMessage[]): Promise<void> {
    log.debug({ to: userId, count: messages.length }, "web replies returned inline");
  }
}
