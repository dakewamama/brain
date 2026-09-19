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
import {
  parseAirtime,
  looksLikeAirtime,
  looksLikeBalance,
  mergeSlots,
  missingSlot,
  hasAnySlot,
  slotPrompt,
  type AirtimeSlots,
} from "./airtimeIntent.js";

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

      let replies: OutboundMessage[];
      let steps = 0;

      // Deterministic fast-path for the live vertical (airtime): parse slots,
      // remember a partial request across turns, and only run the skill when
      // complete. This keeps airtime off LLM variance and makes multi-turn
      // ("MTN" answering "which network?") work.
      const pending = (session?.context?.pendingAirtime as AirtimeSlots | undefined) ?? undefined;
      const parsed = parseAirtime(msg.text);
      const airtimeTurn =
        looksLikeAirtime(msg.text) || (pending != null && hasAnySlot(parsed));

      if (looksLikeBalance(msg.text) && !airtimeTurn) {
        // Balance is deterministic too (don't leave it to LLM variance).
        const exec = await new Executor(skills, getMemory()).run(
          { steps: [{ skill: "check_balance", params: {}, dependsOn: [] }] },
          msg.userId,
        );
        replies = exec.replies.length > 0 ? exec.replies : [menuMessage()];
        steps = 1;
      } else if (airtimeTurn) {
        const merged = mergeSlots(pending ?? {}, parsed);
        const missing = missingSlot(merged);
        if (missing) {
          await sessions.patch(msg.channel, msg.userId, {
            context: { ...(session?.context ?? {}), pendingAirtime: merged },
          });
          replies = [{ kind: "text", text: slotPrompt(missing) }];
        } else {
          const ctx = { ...(session?.context ?? {}) };
          delete (ctx as Record<string, unknown>).pendingAirtime;
          await sessions.patch(msg.channel, msg.userId, { context: ctx });
          const exec = await new Executor(skills, getMemory()).run(
            { steps: [{ skill: "buy_airtime", params: { ...merged } as Record<string, unknown>, dependsOn: [] }] },
            msg.userId,
          );
          replies = exec.replies.length > 0 ? exec.replies : [menuMessage()];
          steps = 1;
        }
      } else {
        // A non-airtime turn cancels any pending airtime, then goes to the planner.
        if (pending) {
          const ctx = { ...(session?.context ?? {}) };
          delete (ctx as Record<string, unknown>).pendingAirtime;
          await sessions.patch(msg.channel, msg.userId, { context: ctx });
        }
        const recent = (await profileStore.summary(conversationId)) ?? undefined;
        const p = await plan(modelProvider, conversationId, msg.text, skills, {
          recent,
        });
        steps = p.steps.length;
        if (p.steps.length > 0) {
          const exec = await new Executor(skills, getMemory()).run(p, msg.userId);
          replies = exec.replies.length > 0 ? exec.replies : [menuMessage()];
        } else {
          replies = [menuMessage()];
        }
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
      log.info({ conversationId, steps, airtime: airtimeTurn }, "pipeline.turn");
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
