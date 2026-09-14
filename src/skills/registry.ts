/**
 * Skill Registry — the nervous system of the agent.
 *
 * A skill is a self-contained, discoverable capability with metadata the model
 * can reason over, plus a handler that executes it. The registry replaces a
 * hardcoded switch with a plug-in architecture: baseline skills are registered at
 * boot, and new ones can be registered at RUNTIME (this is the seam the Learner
 * agent uses to add capabilities without a restart).
 *
 * `listForLLM()` returns provider-agnostic tool definitions so the planner can
 * let the model pick a skill by description rather than keyword matching.
 */
import type { JsonSchema, ToolDefinition } from "../model/types.js";
import type { VerticalHandler } from "../handlers/types.js";

export interface SkillManifest {
  /** Stable id the planner/model selects (baseline skills use the vertical id). */
  id: string;
  /** Human name. */
  name: string;
  /** Natural-language description the model uses to choose this skill. */
  description: string;
  /** JSON-Schema of the inputs this skill expects. */
  parameters: JsonSchema;
  /** Ids/facts that must exist first (e.g. "address_book_entry"). */
  prerequisites?: string[];
  /** The executor. Baseline skills reuse the existing step-machine handlers. */
  handler: VerticalHandler;
  /** Provenance: baseline (shipped) vs learned (added at runtime). */
  origin?: "baseline" | "learned";
}

export class SkillRegistry {
  private skills = new Map<string, SkillManifest>();

  register(skill: SkillManifest): void {
    this.skills.set(skill.id, { origin: "baseline", ...skill });
  }

  find(id: string): SkillManifest | undefined {
    return this.skills.get(id);
  }

  /** The executor for a skill id, or null if unknown. */
  handlerFor(id: string): VerticalHandler | null {
    return this.skills.get(id)?.handler ?? null;
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  list(): SkillManifest[] {
    return [...this.skills.values()];
  }

  /** Tool definitions for the model to select from (planner / dynamic routing). */
  listForLLM(): ToolDefinition[] {
    return this.list().map((s) => ({
      name: s.id,
      description: s.description,
      parameters: s.parameters,
    }));
  }
}
