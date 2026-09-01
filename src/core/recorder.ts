import type { InboundMessage, OutboundMessage, Vertical } from "./types.js";
import type { ConversationStore } from "../store/types.js";
import { newId } from "./ids.js";

export function flattenOutbound(msg: OutboundMessage): string {
  switch (msg.kind) {
    case "text":
      return msg.text;
    case "buttons":
      return `${msg.text} [buttons: ${msg.buttons.map((b) => b.title).join(", ")}]`;
    case "list": {
      const rows = msg.sections
        .flatMap((s) => s.rows.map((r) => r.title))
        .join(", ");
      return `${msg.text} [list: ${rows}]`;
    }
    case "location_request":
      return `${msg.text} [awaiting location]`;
    case "link":
      return `${msg.text} [${msg.label ?? "link"}: ${msg.url}]`;
  }
}

export async function recordInbound(
  store: ConversationStore,
  msg: InboundMessage,
  meta?: {
    vertical?: Vertical;
    step?: string;
  },
): Promise<void> {
  await store.append({
    id: newId("evt"),
    channel: msg.channel,
    userId: msg.userId,
    direction: "in",
    text: msg.text,
    payload: msg,
    vertical: meta?.vertical,
    step: meta?.step,
    timestamp: msg.timestamp,
  });
}

export async function recordOutbound(
  store: ConversationStore,
  channel: InboundMessage["channel"],
  userId: string,
  msg: OutboundMessage,
  meta?: {
    vertical?: Vertical;
    step?: string;
  },
): Promise<void> {
  await store.append({
    id: newId("evt"),
    channel,
    userId,
    direction: "out",
    text: flattenOutbound(msg),
    payload: msg,
    vertical: meta?.vertical,
    step: meta?.step,
    timestamp: Date.now(),
  });
}
