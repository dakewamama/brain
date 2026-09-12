import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  GenerateResult,
  ModelMessage,
  ModelProvider,
  GenerateOptions,
} from "../src/model/types.js";
import { resolveLanguage, languages } from "../src/language/index.js";
import { detectLanguage } from "../src/language/detect.js";
import { mask, restore, localizeStrings } from "../src/language/localize.js";
import { localizeReplies } from "../src/language/service.js";
import type { OutboundMessage } from "../src/core/types.js";

function provider(
  fn: (messages: ModelMessage[], opts?: GenerateOptions) => Partial<GenerateResult>,
): ModelProvider {
  return {
    id: "fake",
    defaultModelId: "fake-1",
    async generate(messages, opts) {
      return {
        text: "",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 1,
        modelId: "fake-1",
        finishReason: "stop",
        ...fn(messages, opts),
      };
    },
  };
}

// A fake translator: prefixes "[t] " and keeps every placeholder intact.
const translator = provider((messages) => {
  const payload = JSON.parse(messages[0].content) as { items: string[] };
  return { json: { translations: payload.items.map((s) => `[t] ${s}`) } };
});

const cfg = { fallback: "en", minConfidence: 0.8 };

test("switching rule: ambiguous first message stays on fallback", () => {
  const r = resolveLanguage(undefined, { language: "yo", confidence: 0.4 }, cfg);
  assert.deepEqual(r, { language: "en", switched: false });
});

test("switching rule: confident non-default switches", () => {
  const r = resolveLanguage(undefined, { language: "pcm", confidence: 0.95 }, cfg);
  assert.deepEqual(r, { language: "pcm", switched: true });
});

test("switching rule: same language never 'switches'", () => {
  const r = resolveLanguage("yo", { language: "yo", confidence: 0.99 }, cfg);
  assert.deepEqual(r, { language: "yo", switched: false });
});

test("switching rule: one ambiguous message does not flip an established language", () => {
  const r = resolveLanguage("yo", { language: "en", confidence: 0.55 }, cfg);
  assert.deepEqual(r, { language: "yo", switched: false });
});

test("switching rule: a clear mid-conversation switch does flip", () => {
  const r = resolveLanguage("yo", { language: "en", confidence: 0.9 }, cfg);
  assert.deepEqual(r, { language: "en", switched: true });
});

test("switching rule: failed detection keeps current language", () => {
  const r = resolveLanguage("ig", null, cfg);
  assert.deepEqual(r, { language: "ig", switched: false });
});

test("mask/restore round-trips numbers, currency and phone byte-identical", () => {
  const src = "Pay ₦1,000 to Nadia's Kitchen on 0803 445 1120";
  const { masked, tokens } = mask(src, ["Nadia's Kitchen"]);
  assert.ok(!/\d/.test(masked), "no digits survive into the masked string");
  assert.ok(!masked.includes("Nadia's Kitchen"), "merchant name is masked");
  assert.equal(restore(masked, tokens), src);
});

test("restore returns null if a placeholder is dropped (caller falls back)", () => {
  const { tokens } = mask("total ₦500", []);
  assert.equal(restore("total", tokens), null);
});

test("localizeStrings keeps protected tokens byte-identical while translating", async () => {
  const src = "Pay ₦1,000 to Nadia's Kitchen on 0803 445 1120";
  const [out] = await localizeStrings(translator, "c1", [src], "Yoruba", [
    "Nadia's Kitchen",
  ]);
  assert.ok(out.startsWith("[t] "), "prose was translated");
  assert.ok(out.includes("₦1,000"), "amount byte-identical");
  assert.ok(out.includes("Nadia's Kitchen"), "merchant byte-identical");
  assert.ok(out.includes("0803 445 1120"), "phone byte-identical");
});

test("localizeStrings falls back to source when a placeholder is lost", async () => {
  const dropper = provider(() => ({ json: { translations: ["totally rewritten"] } }));
  const src = "your total is ₦5,200";
  const [out] = await localizeStrings(dropper, "c2", [src], "Igbo");
  assert.equal(out, src, "lost placeholder => keep the exact source string");
});

test("localizeReplies preserves message structure and amounts", async () => {
  const replies: OutboundMessage[] = [
    {
      kind: "buttons",
      text: "Your total is ₦5,200",
      buttons: [{ id: "pay", title: "Pay now" }],
    },
  ];
  const [out] = await localizeReplies(translator, "c3", replies, "yo", languages);
  assert.equal(out.kind, "buttons");
  if (out.kind !== "buttons") return;
  assert.ok(out.text.includes("₦5,200"), "amount byte-identical");
  assert.ok(out.text.startsWith("[t] "), "text translated");
  assert.equal(out.buttons[0].id, "pay", "button id preserved");
  assert.ok(out.buttons[0].title.startsWith("[t] "), "button label translated");
});

test("localizeReplies is a no-op for the fallback language", async () => {
  const replies: OutboundMessage[] = [{ kind: "text", text: "hello" }];
  const out = await localizeReplies(translator, "c4", replies, "en", languages);
  assert.equal(out[0].kind === "text" && out[0].text, "hello");
});

test("detectLanguage returns a supported code + confidence", async () => {
  const p = provider(() => ({ json: { language: "pcm", confidence: 0.92 } }));
  const d = await detectLanguage(p, "c5", "abeg wetin dey", languages);
  assert.deepEqual(d, { language: "pcm", confidence: 0.92 });
});

test("detectLanguage returns null on model failure (no crash)", async () => {
  const p = provider(() => {
    throw new Error("boom");
  });
  const d = await detectLanguage(p, "c6", "hello", languages);
  assert.equal(d, null);
});
