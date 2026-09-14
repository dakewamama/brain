import type { Vertical } from "../core/types.js";
import type { VerticalHandler } from "./types.js";
import { skills } from "../skills/index.js";

/**
 * Resolve the handler for a vertical through the skill registry, so there is one
 * source of truth for capabilities (and the registry can gain skills at runtime).
 */
export function handlerFor(vertical: Vertical): VerticalHandler | null {
  return skills.handlerFor(vertical);
}
