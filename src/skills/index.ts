/**
 * The process-wide skill registry. Every capability is a skill with a
 * deterministic `execute()` — the Planner selects it and the Executor runs it.
 * (The old conversational vertical handlers were removed in the architecture
 * collapse; new verticals arrive as execute() skills, e.g. airtime.)
 */
import { SkillRegistry } from "./registry.js";
import { payPersonSkill, saveAddressSkill } from "./payments.js";
import { buyAirtimeSkill } from "./airtime.js";

export const skills = new SkillRegistry();

// Atomic money skills (deterministic; call onboarding for custody + off-ramp).
skills.register(saveAddressSkill);
skills.register(payPersonSkill);
skills.register(buyAirtimeSkill);

export { SkillRegistry } from "./registry.js";
export type { SkillManifest } from "./registry.js";
