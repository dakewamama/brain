import { test } from "node:test";
import assert from "node:assert/strict";
import { payPersonSkill, saveAddressSkill } from "../src/skills/payments.js";
import { InMemoryMemory } from "../src/memory/service.js";
import { resetConfigForTests } from "../src/core/config.js";
import type { Entity } from "../src/memory/entities.js";

function textOf(out: { replies: Array<{ kind: string; text?: string }> }): string {
  const r = out.replies[0];
  return r && r.kind === "text" ? (r.text ?? "") : "";
}

function configured() {
  process.env.ONBOARDING_URL = "https://onboard.test";
  process.env.INTERNAL_API_TOKEN = "tok";
  resetConfigForTests();
}
function unconfigure() {
  delete process.env.ONBOARDING_URL;
  delete process.env.INTERNAL_API_TOKEN;
  resetConfigForTests();
}

test("pay_person without saved details asks to save first (needsInput)", async () => {
  configured();
  try {
    const out = await payPersonSkill.execute!(
      { recipient: "mum", amount: 20000 },
      { userId: "u", memory: new InMemoryMemory(), priorResults: {} },
    );
    assert.equal(out.needsInput, true);
    assert.match(textOf(out), /bank details/i);
  } finally {
    unconfigure();
  }
});

test("pay_person with a resolved entity calls onboarding and confirms the amount", async () => {
  configured();
  const orig = globalThis.fetch;
  let calledPath = "";
  globalThis.fetch = (async (url: string) => {
    calledPath = url;
    return new Response(JSON.stringify({ id: "ord_1" }), { status: 200 });
  }) as typeof fetch;
  try {
    const entity: Entity = {
      id: "e",
      userId: "u",
      kind: "person",
      canonicalName: "Chinelo Okafor",
      aliases: ["mum"],
      metadata: { bankCode: "058", accountNumber: "0123456789" },
      coOccurrences: [],
      updatedAt: Date.now(),
    };
    const out = await payPersonSkill.execute!(
      { recipient: "mum", amount: 20000, recipientEntity: entity },
      { userId: "u", memory: new InMemoryMemory(), priorResults: {} },
    );
    assert.match(calledPath, /\/offramp$/);
    assert.match(textOf(out), /Sending ₦20,000 to Chinelo Okafor/);
    assert.equal((out.data as { orderId?: string }).orderId, "ord_1");
  } finally {
    globalThis.fetch = orig;
    unconfigure();
  }
});

test("save_address resolves the account name and saves it to memory", async () => {
  configured();
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accountName: "Chinelo Okafor" }), {
      status: 200,
    })) as typeof fetch;
  const mem = new InMemoryMemory();
  try {
    const out = await saveAddressSkill.execute!(
      { recipient: "mum", bankCode: "058", accountNumber: "0123456789" },
      { userId: "u", memory: mem, priorResults: {} },
    );
    assert.match(textOf(out), /Chinelo Okafor/);
    const saved = await mem.resolveEntity("u", "person", "mum");
    assert.equal(saved.match?.metadata.accountNumber, "0123456789");
  } finally {
    globalThis.fetch = orig;
    unconfigure();
  }
});
