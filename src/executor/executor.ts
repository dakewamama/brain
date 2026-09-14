/**
 * Executor (Core 4) — the action layer.
 *
 * Runs a Plan: for each step it resolves entity references through Memory
 * ("mum" -> Chinelo + her account), then invokes the skill. Results flow to
 * dependent steps. It surfaces ambiguity ("which Priya?") and pauses when a skill
 * needs more input.
 *
 * Safety: the Executor calls a skill's deterministic `execute()` (or defers a
 * conversational skill to its flow). A model NEVER triggers a money movement here
 * — the planner proposes, the skill's code validates and acts.
 */
import type { OutboundMessage } from "../core/types.js";
import type { MemoryService } from "../memory/service.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { Plan, PlanStep } from "../planner/planner.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("executor");

// Param keys that name a person / a place — resolved against Memory before a skill runs.
const PERSON_KEYS = ["recipient", "person", "to", "payee", "beneficiary", "who"];
const PLACE_KEYS = ["location", "address", "place", "destination", "dropoff"];

export interface ExecutionResult {
  replies: OutboundMessage[];
  completed: boolean;
  /** A single conversational skill the caller should run via the normal flow. */
  deferred?: PlanStep;
}

export class Executor {
  constructor(
    private skills: SkillRegistry,
    private memory: MemoryService,
  ) {}

  async run(plan: Plan, userId: string): Promise<ExecutionResult> {
    const replies: OutboundMessage[] = [];
    const priorResults: Record<number, unknown> = {};

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const skill = this.skills.find(step.skill);
      if (!skill) {
        log.warn({ skill: step.skill }, "plan referenced unknown skill; skipping");
        continue;
      }

      // A conversational (flow) skill can't run headless in a multi-step plan.
      // Defer to the normal flow — supported for a lone step.
      if (!skill.execute) {
        return { replies, completed: false, deferred: step };
      }

      // Resolve entity references before the skill sees the params.
      const resolved = await this.resolveParams(step.params, userId);
      if (resolved.clarify) {
        // Render candidates as tappable chips (id "q:<name>" so a tap is sent
        // back as a normal message and re-resolves to the exact person).
        replies.push({
          kind: "buttons",
          text: resolved.clarify.text,
          buttons: resolved.clarify.options.map((o) => ({ id: `q:${o}`, title: o })),
        });
        return { replies, completed: false };
      }

      const outcome = await skill.execute(resolved.params, {
        userId,
        memory: this.memory,
        priorResults,
      });
      replies.push(...outcome.replies);
      priorResults[i] = outcome.data;
      if (outcome.needsInput) return { replies, completed: false };
    }

    return { replies, completed: true };
  }

  /** Attach resolved entities for person/place params; ask to disambiguate on a
   *  close call rather than risk paying the wrong person. */
  private async resolveParams(
    params: Record<string, unknown>,
    userId: string,
  ): Promise<{
    params: Record<string, unknown>;
    clarify?: { text: string; options: string[] };
  }> {
    const out: Record<string, unknown> = { ...params };
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== "string") continue;
      const kind = PERSON_KEYS.includes(key)
        ? "person"
        : PLACE_KEYS.includes(key)
          ? "place"
          : null;
      if (!kind) continue;
      const r = await this.memory.resolveEntity(userId, kind, value);
      if (r.ambiguous) {
        return {
          params: out,
          clarify: {
            text: `I know a few that match "${value}". Which one?`,
            options: r.candidates.map((c) => c.entity.canonicalName),
          },
        };
      }
      if (r.match) out[`${key}Entity`] = r.match;
    }
    return { params: out };
  }
}
