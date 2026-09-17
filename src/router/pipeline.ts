import type {
  InboundMessage,
  OutboundMessage,
  SessionState,
} from "../core/types.js";
import type { SessionStore, ConversationStore } from "../store/types.js";
import { recordInbound, recordOutbound } from "../core/recorder.js";
import { childLogger } from "../core/logger.js";
import { menuMessage } from "./menu.js";
import { modelProvider } from "../model/index.js";
import { languages } from "../language/index.js";
import { localizeReplies } from "../language/service.js";
import { profileStore } from "../store/index.js";
import { skills } from "../skills/index.js";
import { plan } from "../planner/planner.js";
import { Executor } from "../executor/executor.js";
import { getMemory } from "../memory/index.js";

const log = childLogger("pipeline");

export interface Pipeline {
  process(msg: InboundMessage): Promise<OutboundMessage[]>;
}

/**
 * The one and only decision path: the Planner turns a message into an ordered
 * list of skill steps; the Executor runs them (resolving entities, asking to
 * disambiguate, calling deterministic skill code). There are no keyword routers,
 * no separate intent classifier, and no comprehension layer — the model plans,
 * the code executes. An empty plan (greeting, small talk, or something Axis can't
 * yet do) falls to the menu.
 */
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

      const recent = (await profileStore.summary(conversationId)) ?? undefined;
      const p = await plan(modelProvider, conversationId, msg.text, skills, {
        recent,
      });

      let replies: OutboundMessage[];
      if (p.steps.length > 0) {
        const exec = await new Executor(skills, getMemory()).run(p, msg.userId);
        replies = exec.replies.length > 0 ? exec.replies : [menuMessage()];
      } else {
        replies = [menuMessage()];
      }

      // Localize English-authored replies into the session language, if one is
      // set. Protected terms (names, addresses) pass through byte-identical.
      const language = session?.language ?? languages.fallback;
      let out = replies;
      if (languages.enabled && language !== languages.fallback) {
        out = await localizeReplies(
          modelProvider,
          conversationId,
          replies,
          language,
          languages,
          collectProtectedTerms(session),
        );
      }

      for (const reply of out) {
        await recordOutbound(conversations, msg.channel, msg.userId, reply, {
          vertical: session?.vertical,
          step: session?.step,
        });
      }
      log.info({ conversationId, steps: p.steps.length }, "pipeline.turn");
      return out;
    },
  };
}

/** Terms that must survive localization byte-identical: vendor/item names held in
 *  session context, plus saved address labels. */
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
