import type { OutboundMessage } from "../core/types.js";

export function menuMessage(): OutboundMessage {
  return {
    kind: "buttons",
    text: "Hi, I'm Axis. I can help you order food, send a gift, or shop. Just tell me what you need.",
    buttons: [
      { id: "menu_food", title: "🍔 Order food" },
      { id: "menu_gift", title: "🎁 Send a gift" },
      { id: "menu_shop", title: "🛍️ Shop" },
    ],
  };
}

export function helpMessage(): OutboundMessage {
  return {
    kind: "text",
    text:
      "Here's what I can do:\n" +
      '• Order food. Try "chicken wings from Nadia"\n' +
      '• Send a gift. Try "send lunch to Ebele"\n' +
      '• Shop. Try "buy an oraimo powerbank"\n\n' +
      'Type "cancel" any time to start over.',
  };
}
