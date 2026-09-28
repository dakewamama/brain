import { randomUUID } from "node:crypto";
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
  getCaseRunner,
  getCaseStore,
} from "../cases/index.js";
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
  process(msg: InboundMessage, opts?: { skipClaim?: boolean }): Promise<OutboundMessage[]>;
}

/** Replies that read as answers to an open confirmation (yes/no) rather than
 *  new instructions. Only these are routed into a waiting case. */
const CONFIRM_REPLY = /^(yes|y|no|n|confirm|cancel|stop|ok|okay|go ahead)\b/i;

/**
 * The one and only decision path: the Planner turns a message into an ordered
 * list of skill steps; the Executor runs them (resolving entities, asking to
 * disambiguate, calling deterministic skill code). Money skills route into the
 * Case runtime — durable, policy-gated, verifier-checked — so the same
 * implementation serves both the deterministic fast path and the planner.
 * An empty plan (greeting, small talk, or something Axis can't yet do) falls
 * to the menu.
 */
export function createPipeline(deps: {
  sessions: SessionStore;
  conversations: ConversationStore;
}): Pipeline {
  const { sessions, conversations } = deps;
  return {
    async process(msg: InboundMessage, opts?: { skipClaim?: boolean }): Promise<OutboundMessage[]> {
      // Durable acceptance: the first arrival owns processing. A replayed
      // webhook (same provider message id on the same channel) is dropped here.
      // Retry sweeps pass skipClaim — the row already exists from the first try.
      let inboundId = `inb_${randomUUID()}`;
      if (!opts?.skipClaim) {
        const providerMessageId = msg.messageId ?? `anon-${randomUUID()}`;
        const claimed = await getCaseStore().claimInbound({
          id: inboundId,
          channel: msg.channel,
          providerMessageId,
          payload: msg as unknown as Record<string, unknown>,
        });
        if (!claimed) {
          log.info({ channel: msg.channel, providerMessageId }, "duplicate inbound dropped");
          return [];
        }
      }

      const session = await sessions.get(msg.channel, msg.userId);
      await recordInbound(conversations, msg, {
        vertical: session?.vertical,
        step: session?.step,
      });
      const conversationId = `${msg.channel}:${msg.userId}`;

      let replies: OutboundMessage[];
      let steps = 0;

      // A case waiting on the user (e.g. "Confirm: buy ₦25,000 ...? yes/no")
      // consumes confirmation-style replies and resumes durably.
      const runner = getCaseRunner();
      if (CONFIRM_REPLY.test(msg.text.trim())) {
        const signaled = await runner.signalLatest(msg.userId, msg.channel, msg.text.trim());
        if (signaled) {
          replies = signaled.replies.length > 0 ? signaled.replies : [menuMessage()];
          steps = 1;
          await finish(msg, conversations, session, conversationId, replies, steps, inboundId);
          return replies;
        }
      }

      // Deterministic fast-path for the live vertical (airtime): parse slots,
      // remember a partial request across turns, and start a Case when complete.
      // The Case (not this code) runs policy → reserve → provider → verify.
      const pending = (session?.context?.pendingAirtime as AirtimeSlots | undefined) ?? undefined;
      const parsed = parseAirtime(msg.text);
      const airtimeTurn =
        looksLikeAirtime(msg.text) || (pending != null && hasAnySlot(parsed));

      if (looksLikeBalance(msg.text) && !airtimeTurn) {
        // Balance is deterministic too (don't leave it to LLM variance).
        const exec = await new Executor(skills, getMemory()).run(
          { steps: [{ skill: "check_balance", params: {}, dependsOn: [] }] },
          msg.userId,
          { channel: msg.channel },
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
          const outcome = await runner.start({
            userId: msg.userId,
            channel: msg.channel,
            goal: `buy ${merged.amount} NGN ${merged.network ?? ""} airtime for ${merged.phone}`.replace(/\s+/g, " "),
            playbookId: "airtime",
            context: { slots: merged as Record<string, unknown> },
          });
          replies = outcome.replies.length > 0 ? outcome.replies : [menuMessage()];
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
          const exec = await new Executor(skills, getMemory()).run(
            p,
            msg.userId,
            { channel: msg.channel },
          );
          replies = exec.replies.length > 0 ? exec.replies : [menuMessage()];
        } else {
          replies = [menuMessage()];
        }
      }

      await finish(msg, conversations, session, conversationId, replies, steps, inboundId);
      return replies;
    },
  };
}

/** Localize, record outbound, mark inbound processed, log. Shared tail. */
async function finish(
  msg: InboundMessage,
  conversations: ConversationStore,
  session: SessionState | null,
  conversationId: string,
  replies: OutboundMessage[],
  steps: number,
  inboundId: string,
): Promise<void> {
  await getCaseStore().markInboundProcessed(inboundId).catch(() => {});
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
  log.info({ conversationId, steps }, "pipeline.turn");
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
