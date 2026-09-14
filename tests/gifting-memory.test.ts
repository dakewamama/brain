import { test } from "node:test";
import assert from "node:assert/strict";
import { GiftingHandler } from "../src/handlers/gifting.js";
import { getMemory } from "../src/memory/index.js";
import type { InboundMessage, SessionState } from "../src/core/types.js";

function msg(userId: string, text: string): InboundMessage {
  return { channel: "web", userId, text, timestamp: Date.now() };
}
function session(step: string): SessionState {
  return {
    channel: "web",
    userId: "",
    vertical: "gifting",
    step,
    context: {},
    savedLocations: [],
    updatedAt: Date.now(),
  };
}

test("gifting remembers a recipient, then resolves them without a number", async () => {
  const h = new GiftingHandler();
  const uid = `gm_${Date.now()}`;

  // First time: name + number -> saved to memory
  const first = await h.handle(msg(uid, "Ebele 08031234567"), session("awaiting_recipient"));
  assert.match(
    first.replies[0].kind === "text" ? first.replies[0].text : "",
    /gift for Ebele/,
  );
  const saved = await getMemory().resolveEntity(uid, "person", "Ebele");
  assert.equal(saved.match?.metadata.phone, "08031234567");

  // Later: just the name, no number -> resolved from memory, no re-ask
  const second = await h.handle(msg(uid, "Ebele"), session("awaiting_recipient"));
  const t = second.replies[0].kind === "text" ? second.replies[0].text : "";
  assert.match(t, /gift for Ebele/);
  assert.doesNotMatch(t, /WhatsApp number/);
});
