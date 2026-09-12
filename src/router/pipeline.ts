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
import { modelProvider } from "../model/index.js";
import { conversationModelCalls } from "../model/instrument.js";
import { languages } from "../language/index.js";
import { applyInboundLanguage, localizeReplies } from "../language/service.js";
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

      // Language: detect + apply the switching rule, store on the conversation.
      // Gated on `languages.enabled` (a model key) so unconfigured deployments
      // stay byte-for-byte on the fallback language with no model calls.
      const conversationId = `${msg.channel}:${msg.userId}`;
      let language = session?.language ?? languages.fallback;
      let switched = false;
      if (languages.enabled) {
        const outcome = await applyInboundLanguage(
          modelProvider,
          conversationId,
          session?.language,
          msg.text,
          languages,
        );
        language = outcome.language;
        switched = outcome.switched;
        await sessions.patch(msg.channel, msg.userId, { language });
      }

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

      // Localize into the conversation's language. Handler text is authored in
      // the fallback language, so this is a no-op for fallback. Numbers, money,
      // phone numbers, and known merchant/address terms are masked before the
      // model sees them, so they are byte-identical in the output.
      let out = replies;
      if (languages.enabled && language !== languages.fallback) {
        out = await localizeReplies(
          modelProvider,
          conversationId,
          replies,
          language,
          languages,
          collectProtectedTerms(finalSession),
        );
      }

      for (const reply of out) {
        await recordOutbound(conversations, msg.channel, msg.userId, reply, {
          vertical: finalSession?.vertical,
          step: finalSession?.step,
        });
      }

      log.info(
        {
          conversationId,
          language,
          switched,
          modelCalls: conversationModelCalls(conversationId),
        },
        "pipeline.turn",
      );
      return out;
    },
  };
}

/** Terms that must survive localization byte-identical: merchant/vendor names and
 *  items held in session context, plus saved address/labels. */
function collectProtectedTerms(session: SessionState | null): string[] {
  if (!session) return [];
  const terms: string[] = [];
  for (const v of Object.values(session.context)) {
    if (typeof v === "string") terms.push(v);
  }
  for (const loc of session.savedLocations) {
    if (loc.address) terms.push(loc.address);
    if (loc.label) terms.push(loc.label);
  }
  return terms;
}
