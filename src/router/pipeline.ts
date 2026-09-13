import type {
  InboundMessage,
  OutboundMessage,
  SessionState,
  Vertical,
} from "../core/types.js";
import type { SessionStore, ConversationStore } from "../store/types.js";
import { route, detectCommand } from "./intent.js";
import { handlerFor } from "../handlers/index.js";
import { recordInbound, recordOutbound } from "../core/recorder.js";
import { childLogger } from "../core/logger.js";
import { menuMessage, helpMessage } from "./menu.js";
import { modelProvider } from "../model/index.js";
import { conversationModelCalls } from "../model/instrument.js";
import { languages, resolveLanguage } from "../language/index.js";
import { localizeReplies } from "../language/service.js";
import {
  understand,
  isSocial,
  type Intent,
  type Understanding,
} from "../understanding/understand.js";
const log = childLogger("pipeline");

export interface Pipeline {
  process(msg: InboundMessage): Promise<OutboundMessage[]>;
}

function intentToVertical(intent: Intent): Vertical {
  switch (intent) {
    case "order":
      return "delivery";
    case "gift":
      return "gifting";
    case "shop":
      return "affiliate";
    default:
      return "unknown";
  }
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

      const conversationId = `${msg.channel}:${msg.userId}`;
      const command = detectCommand(msg.text);
      const hardCommand = command === "cancel" || command === "reset";
      const inFlow = Boolean(
        session && session.step !== "idle" && session.vertical !== "unknown",
      );
      const isButtonTap = Boolean(
        (msg.data as { buttonId?: unknown } | undefined)?.buttonId,
      );
      // One model call comprehends fresh text turns (language + intent + entities
      // + an in-language social reply). We skip it for hard commands, mid-flow
      // continuations, and button taps — those are handled deterministically and
      // don't need (or shouldn't spend a call on) comprehension.
      const comprehend =
        languages.enabled &&
        Boolean(msg.text.trim()) &&
        !isButtonTap &&
        !hardCommand &&
        !inFlow;

      let language = session?.language ?? languages.fallback;
      let switched = false;
      let u: Understanding | null = null;
      if (comprehend) {
        u = await understand(modelProvider, conversationId, msg.text, languages, {
          flow: session
            ? { vertical: session.vertical, step: session.step }
            : undefined,
          userName: msg.userName,
          firstTurn: !session,
        });
        if (u) {
          const resolved = resolveLanguage(
            session?.language,
            { language: u.language, confidence: u.confidence },
            { fallback: languages.fallback, minConfidence: languages.minConfidence },
          );
          language = resolved.language;
          switched = resolved.switched;
          await sessions.patch(msg.channel, msg.userId, { language });
        }
      }

      let replies: OutboundMessage[] = [];
      let patch: Partial<SessionState> | undefined;
      // True when we're sending the model's own reply, already in the user's
      // language — so we must NOT run it through localization again.
      let alreadyLocalized = false;

      if (hardCommand) {
        await sessions.clear(msg.channel, msg.userId);
        replies = [
          { kind: "text", text: "Okay, cleared. What would you like to do?" },
        ];
      } else if (u) {
        // Model-driven dispatch.
        if (u.intent === "cancel") {
          await sessions.clear(msg.channel, msg.userId);
          replies = u.reply
            ? [{ kind: "text", text: u.reply }]
            : [{ kind: "text", text: "Okay, cleared. What would you like to do?" }];
          alreadyLocalized = Boolean(u.reply);
        } else if (u.intent === "track") {
          replies = [
            { kind: "text", text: "You don't have an active order to track yet." },
          ];
        } else if (u.intent === "help") {
          replies = u.reply ? [{ kind: "text", text: u.reply }] : [helpMessage()];
          alreadyLocalized = Boolean(u.reply);
        } else if (isSocial(u.intent)) {
          replies = u.reply ? [{ kind: "text", text: u.reply }] : [menuMessage()];
          alreadyLocalized = Boolean(u.reply);
        } else {
          // order / gift / shop → the real (catalog-backed) handler.
          const vertical = intentToVertical(u.intent);
          const handler = handlerFor(vertical);
          if (!handler) {
            replies = [{ kind: "text", text: "That's coming soon." }];
          } else {
            const active =
              session ??
              (await sessions.patch(msg.channel, msg.userId, {
                vertical,
                step: "idle",
              }));
            const result = await handler.start(msg, active);
            replies = result.replies;
            patch = result.sessionPatch;
          }
        }
      } else {
        // Fallback: keyword router. Used when no model is configured, a model
        // call failed, we're mid-flow, or it's a button tap.
        const decision = route(msg, session);
        log.debug({ user: msg.userId, decision, text: msg.text }, "routed (fallback)");
        if (decision.command === "help") {
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
      }

      if (patch) {
        await sessions.patch(msg.channel, msg.userId, patch);
      }
      const finalSession = await sessions.get(msg.channel, msg.userId);

      // Localize deterministic (English-authored) replies into the conversation
      // language. Model social replies are already in-language, so they skip
      // this. Numbers/money/phone/merchant terms are masked before the model
      // sees them, so they stay byte-identical.
      let out = replies;
      if (
        languages.enabled &&
        language !== languages.fallback &&
        !alreadyLocalized
      ) {
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
          intent: u?.intent ?? "fallback",
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
