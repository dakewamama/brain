/**
 * Planner (Core 3) — the reasoning layer.
 *
 * Turns a raw user message into an ordered plan of steps, each bound to ONE skill
 * from the registry, with dependencies between steps. This is what ends
 * "one intent per turn": a compound request ("pay mum AND order jollof") becomes
 * two steps; a mid-flow question or greeting becomes an empty plan (the caller
 * handles conversation).
 *
 * The model only SELECTS skills and EXTRACTS params the user actually stated — it
 * never invents an amount, price, or fact. The executor (Core 4) runs the plan;
 * skills fetch real data and deterministic code produces any number.
 */
import type { JsonSchema, ModelProvider } from "../model/types.js";
import { instrumentedGenerate } from "../model/instrument.js";
import { isModelError } from "../model/errors.js";
import { childLogger } from "../core/logger.js";
import type { SkillRegistry } from "../skills/registry.js";

const log = childLogger("planner");

export interface PlanStep {
  /** A skill id from the registry. */
  skill: string;
  /** Params extracted from the message (only what the user stated). */
  params: Record<string, unknown>;
  /** Indices of earlier steps this one depends on. */
  dependsOn: number[];
}

export interface Plan {
  steps: PlanStep[];
}

export async function plan(
  provider: ModelProvider,
  conversationId: string,
  text: string,
  skills: SkillRegistry,
  ctx?: { recent?: string },
): Promise<Plan> {
  const manifests = skills.list();
  const ids = manifests.map((s) => s.id);
  if (ids.length === 0) return { steps: [] };

  const catalog = manifests.map((s) => `- ${s.id}: ${s.description}`).join("\n");
  const schema: JsonSchema = {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            skill: { type: "string" },
            params: { type: "object" },
            dependsOn: { type: "array", items: { type: "number" } },
          },
          required: ["skill"],
        },
      },
    },
    required: ["steps"],
  };

  const recentNote = ctx?.recent ? ` Context about the user: ${ctx.recent}.` : "";
  const system =
    `You are the Planner for Axis, a Nigerian commerce agent. Decompose the ` +
    `user's message into an ORDERED list of steps. Each step uses exactly one ` +
    `skill id from this list:\n${catalog}\n\n` +
    `Rules:\n` +
    `- Split compound requests ("pay mum and order food") into multiple steps.\n` +
    `- A step may depend on an earlier one via dependsOn (array of step indices).\n` +
    `- params: only values the user actually stated (amounts, names, items). ` +
    `NEVER invent a price, fee, total, or fact the user didn't say.\n` +
    `- If the message needs no skill (a greeting, small talk, or a question), ` +
    `return {"steps": []}.${recentNote}`;

  try {
    const r = await instrumentedGenerate(
      provider,
      conversationId,
      "plan",
      [{ role: "user", content: text }],
      { system, responseSchema: schema, temperature: 0.2, maxOutputTokens: 1024 },
    );
    const raw = (r.json as { steps?: unknown })?.steps;
    const steps = Array.isArray(raw) ? raw : [];
    const valid: PlanStep[] = steps
      .map((s) => s as Record<string, unknown>)
      .filter((s) => typeof s?.skill === "string" && ids.includes(s.skill as string))
      .map((s) => ({
        skill: s.skill as string,
        params:
          s.params && typeof s.params === "object"
            ? (s.params as Record<string, unknown>)
            : {},
        dependsOn: Array.isArray(s.dependsOn)
          ? (s.dependsOn.filter((n) => typeof n === "number") as number[])
          : [],
      }));
    return { steps: valid };
  } catch (err) {
    log.warn(
      { conversationId, kind: isModelError(err) ? err.kind : "unknown" },
      "planning failed",
    );
    return { steps: [] };
  }
}
