import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buyAirtimeSkill,
  normalizePhone,
  validNigerianPhone,
  networkFromPhone,
} from "../src/skills/airtime.js";
import { resetConfigForTests } from "../src/core/config.js";
import type { SkillContext } from "../src/skills/registry.js";

const ctx = { userId: "user-1" } as SkillContext; // owner for the debit

test("normalizePhone accepts +234/234 and strips formatting", () => {
  assert.equal(normalizePhone("+234 803 123 4567"), "08031234567");
  assert.equal(normalizePhone("2348031234567"), "08031234567");
  assert.equal(normalizePhone("0803-123-4567"), "08031234567");
});

test("validNigerianPhone enforces 0 + 10 digits", () => {
  assert.equal(validNigerianPhone("08031234567"), true);
  assert.equal(validNigerianPhone("0803123456"), false);
  assert.equal(validNigerianPhone("18031234567"), false);
});

test("networkFromPhone infers by prefix", () => {
  assert.equal(networkFromPhone("08031234567"), "mtn");
  assert.equal(networkFromPhone("08051234567"), "glo");
  assert.equal(networkFromPhone("08021234567"), "airtel");
  assert.equal(networkFromPhone("08091234567"), "9mobile");
  assert.equal(networkFromPhone("08001234567"), null);
});

test("buy_airtime asks for a valid number / amount before calling out", async () => {
  const noPhone = await buyAirtimeSkill.execute!({ amount: 500 }, ctx);
  assert.equal(noPhone.needsInput, true);
  const badPhone = await buyAirtimeSkill.execute!({ amount: 500, phone: "123" }, ctx);
  assert.equal(badPhone.needsInput, true);
  const noAmount = await buyAirtimeSkill.execute!({ phone: "08031234567" }, ctx);
  assert.equal(noAmount.needsInput, true);
});

// Stub the onboarding HTTP boundary (a network double, not fake product data).
function withOnboarding(
  response: { ok: boolean; status: number; body: unknown },
  run: (captured: { url: string; body: unknown }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const realFetch = globalThis.fetch;
    const captured = { url: "", body: null as unknown };
    process.env.ONBOARDING_URL = "https://onboarding.test";
    process.env.INTERNAL_API_TOKEN = "tok";
    resetConfigForTests();
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      // Provision is called first and idempotently; return a wallet address so the
      // buy path (and the fund message) can use it. Capture only the buy call.
      if (String(url).endsWith("/airtime/provision")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ userId: "user-1", address: "Wa11etAddr111", created: true }),
        } as Response;
      }
      captured.url = String(url);
      captured.body = init?.body ? JSON.parse(init.body) : null;
      return {
        ok: response.ok,
        status: response.status,
        text: async () => JSON.stringify(response.body),
      } as Response;
    }) as typeof fetch;
    try {
      await run(captured);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ONBOARDING_URL;
      delete process.env.INTERNAL_API_TOKEN;
      resetConfigForTests();
    }
  };
}

test(
  "buy_airtime delivers: infers network, calls /airtime, confirms",
  withOnboarding(
    { ok: true, status: 200, body: { status: "delivered" } },
    async (captured) => {
      const out = await buyAirtimeSkill.execute!(
        { amount: 500, phone: "0803 123 4567" },
        ctx,
      );
      assert.match(captured.url, /\/airtime$/);
      const body = captured.body as {
        network: string;
        amount: number;
        phone: string;
        owner: string;
        idempotencyKey: string;
      };
      assert.equal(body.network, "mtn");
      assert.equal(body.amount, 500);
      assert.equal(body.phone, "08031234567");
      assert.equal(body.owner, "user-1");
      assert.match(body.idempotencyKey, /^airtime-user-1-/);
      assert.equal(out.needsInput, undefined);
      assert.match(
        out.replies[0].kind === "text" ? out.replies[0].text : "",
        /Done\. ₦500 MTN airtime sent to 08031234567/,
      );
    },
  ),
);

test(
  "buy_airtime pending (202) says processing, not done",
  withOnboarding(
    { ok: true, status: 202, body: { status: "pending" } },
    async () => {
      const out = await buyAirtimeSkill.execute!(
        { network: "glo", amount: 100, phone: "08051234567" },
        ctx,
      );
      assert.match(
        out.replies[0].kind === "text" ? out.replies[0].text : "",
        /processing/i,
      );
    },
  ),
);

test(
  "buy_airtime with an empty balance tells the user where to fund",
  withOnboarding(
    { ok: false, status: 402, body: { error: "insufficient balance" } },
    async () => {
      const out = await buyAirtimeSkill.execute!(
        { network: "mtn", amount: 100, phone: "08031234567" },
        ctx,
      );
      assert.equal(out.needsInput, true);
      const text = out.replies[0].kind === "text" ? out.replies[0].text : "";
      assert.match(text, /Wa11etAddr111/); // the provisioned deposit address
      assert.match(text, /add usdc|fund/i);
    },
  ),
);
