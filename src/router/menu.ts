import type { OutboundMessage } from "../core/types.js";

// Shown when the planner returns no steps (a greeting, small talk, or something
// Axis can't yet fulfil). Plain text, no dead buttons: capabilities are whatever
// skills are registered, and the example reflects the live vertical.
export function menuMessage(): OutboundMessage {
  return {
    kind: "text",
    text:
      "Right now I can buy airtime and data. Try \"buy ₦500 MTN airtime for " +
      "08031234567\". Transfers and bills are coming soon.",
  };
}
