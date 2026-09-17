import type { OutboundMessage } from "../core/types.js";

// Shown when the planner returns no steps (a greeting, small talk, or something
// Axis can't yet fulfil). Plain text, no dead buttons: capabilities are whatever
// skills are registered, and the example reflects the live vertical.
export function menuMessage(): OutboundMessage {
  return {
    kind: "text",
    text: 'Hi, I\'m Axis. Tell me what you need, for example "buy ₦500 airtime for 08012345678".',
  };
}
