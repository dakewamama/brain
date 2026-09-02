import type {
  InboundMessage,
  OutboundMessage,
  SessionState,
} from "../core/types.js";
import type { SessionStore, ConversationStore } from "../store/types.js";
import { route } from "./intent.js";
import { handlerFor } from "../handlers/index.js";
import { recordInbound, recordOutbound } from "../core/recorder.js";
import { childLogger } from "../core/logger.js";
import { menuMessage, helpMessage } from "./menu.js";
const log = childLogger("pipeline");

export interface Pipeline {
  process(msg: InboundMessage): Promise<OutboundMessage[]>;
}

export function createPipeline(deps: {
  sessions: SessionStore;
  conversations: ConversationStore;
}): Pipeline {
  const { sessions, conversations } = deps;
  return {
    async process(msg: InboundMessage): Promise<OutboundMessage[]> {
      const session = await sessions.get(msg.channel, msg.userId);
      await recordInbound(conversations, msg, {
        vertical: session?.vertical,
        step: session?.step,
      });
      const decision = route(msg, session);
      log.debug(
        { user: msg.userId, decision, text: msg.text },
        "routed message",
      );
      let replies: OutboundMessage[] = [];
      let patch: Partial<SessionState> | undefined;
      if (decision.command === "cancel" || decision.command === "reset") {
        await sessions.clear(msg.channel, msg.userId);
        replies = [
          { kind: "text", text: "Okay, cleared. What would you like to do?" },
        ];
      } else if (decision.command === "help") {
        replies = [helpMessage()];
      } else if (decision.command === "menu") {
        replies = [menuMessage()];
      } else if (decision.vertical === "unknown") {
        replies = [menuMessage()];
      } else {
        const handler = handlerFor(decision.vertical);
        if (!handler) {
          replies = [
            { kind: "text", text: "That's coming soon. Try the menu for now." },
          ];
        } else {
          const active =
            session ??
            (await sessions.patch(msg.channel, msg.userId, {
              vertical: decision.vertical,
              step: "idle",
            }));
          const result = decision.continued
            ? await handler.handle(msg, active)
            : await handler.start(msg, active);
          replies = result.replies;
          patch = result.sessionPatch;
        }
      }
      if (patch) {
        await sessions.patch(msg.channel, msg.userId, patch);
      }
      const finalSession = await sessions.get(msg.channel, msg.userId);
      for (const reply of replies) {
        await recordOutbound(conversations, msg.channel, msg.userId, reply, {
          vertical: finalSession?.vertical,
          step: finalSession?.step,
        });
      }
      return replies;
    },
  };
}
